require("dotenv").config();
const { ethers } = require("hardhat");
const fs = require("fs");
const path = require("path");

const PRESALE = process.env.PRESALE_ADDRESS;
const USDC = process.env.USDC_ADDRESS;
const N = Number(process.env.WALLETS || 3);
const GAS_ETH = process.env.GAS_ETH || "0.003";
const SKIP_ETH = process.env.SKIP_ETH === "1";
const USDC_PER_WALLET = 800n * 10n ** 6n;
const FILE = path.join(__dirname, "..", ".wallets.json");

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function transfer(address,uint256) returns (bool)",
  "function approve(address,uint256) returns (bool)",
  "function mint(address,uint256)",
];
const FEED_ABI = ["function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)"];

const usd = (n) => ethers.parseUnits(String(n), 18);
const usdc6 = (n) => ethers.parseUnits(String(n), 6);
const reasonOf = (e) => e.reason || e.shortMessage || (e.message || "").slice(0, 120);

async function main() {
  if (!PRESALE) throw new Error("Set PRESALE_ADDRESS in .env (the NEW presale address)");
  if (!USDC) throw new Error("Set USDC_ADDRESS in .env (mock USDC address on Sepolia)");

  const gi = fs.existsSync(".gitignore") ? fs.readFileSync(".gitignore", "utf8") : "";
  if (!gi.split(/\r?\n/).map((l) => l.trim()).includes(".wallets.json")) {
    throw new Error("Add the line .wallets.json to .gitignore first, then run again");
  }

  const [deployer] = await ethers.getSigners();
  const presale = await ethers.getContractAt("OdysseyPresale", PRESALE);
  const usdcDeployer = await ethers.getContractAt(ERC20_ABI, USDC, deployer);
  const ethFeed = await ethers.getContractAt(FEED_ABI, await presale.ethUsdFeed());
  const MIN = await presale.MIN_PURCHASE_USD();
  const treasury = await presale.treasury();

  let keys = fs.existsSync(FILE) ? JSON.parse(fs.readFileSync(FILE, "utf8")) : [];
  while (keys.length < N) keys.push(ethers.Wallet.createRandom().privateKey);
  fs.writeFileSync(FILE, JSON.stringify(keys, null, 2));
  const wallets = keys.slice(0, N).map((k) => new ethers.Wallet(k, ethers.provider));

  const [, ethPrice] = await ethFeed.latestRoundData();
  const ethFor81 = (usd("81") * 10n ** 8n) / ethPrice;

  const ethNeeded = wallets.map((_, i) => ethers.parseEther(GAS_ETH) + (i === 0 && !SKIP_ETH ? ethFor81 : 0n));
  const totalEth = ethNeeded.reduce((a, b) => a + b, 0n);
  const dBal = await ethers.provider.getBalance(deployer.address);
  console.log(`Deployer ETH: ${ethers.formatEther(dBal)}  (max needed: ${ethers.formatEther(totalEth)})`);
  if (dBal < totalEth + ethers.parseEther("0.01")) throw new Error("Deployer has too little Sepolia ETH");
  const needUsdc = USDC_PER_WALLET * BigInt(N);
  const dUsdc = await usdcDeployer.balanceOf(deployer.address);
  if (dUsdc < needUsdc) {
    try {
      await (await usdcDeployer.mint(deployer.address, needUsdc - dUsdc)).wait();
      console.log("minted mock USDC to the deployer");
    } catch (e) {
      throw new Error("Deployer has too little mock USDC and mint() failed: " + reasonOf(e));
    }
  }

  for (let i = 0; i < N; i++) {
    const w = wallets[i];
    const bal = await ethers.provider.getBalance(w.address);
    if (bal < ethNeeded[i]) {
      await (await deployer.sendTransaction({ to: w.address, value: ethNeeded[i] - bal })).wait();
    }
    const ub = await usdcDeployer.balanceOf(w.address);
    if (ub < USDC_PER_WALLET) await (await usdcDeployer.transfer(w.address, USDC_PER_WALLET - ub)).wait();
    const usdcW = await ethers.getContractAt(ERC20_ABI, USDC, w);
    await (await usdcW.approve(PRESALE, ethers.MaxUint256)).wait();
    console.log(`funded + approved wallet ${i}: ${w.address}`);
  }

  const plan = (i) =>
    i === 0 && !SKIP_ETH
      ? [["ETH", 81], ["USDC", 400], ["USDC", 219], ["USDC", 80]]
      : [["USDC", 79], ["USDC", 80], ["USDC", 400], ["USDC", 220], ["USDC", 80]];

  // balances of the treasury before the test (the money must arrive there at once)
  const usdcRead = await ethers.getContractAt(ERC20_ABI, USDC);
  const tUsdc0 = await usdcRead.balanceOf(treasury);
  const tEth0 = await ethers.provider.getBalance(treasury);
  let usdcPaid = 0n;
  let ethPaid = 0n;

  const rows = [];
  let failures = 0;
  const soldBefore = await presale.totalSold();

  for (let i = 0; i < N; i++) {
    const w = wallets[i];
    const p = presale.connect(w);
    for (const [asset, amount] of plan(i)) {
      const usd18 = usd(amount);
      const allowance = await presale.remainingAllowanceUsd(w.address);
      const expectOk = usd18 >= MIN && usd18 <= allowance;

      const [fn, args] =
        asset === "ETH"
          ? [p.buyWithETH, [0, { value: ethFor81 }]]
          : [p.buyWithToken, [USDC, usdc6(amount), 0]];

      let ok = true;
      let reason = "";
      try {
        await fn.staticCall(...args);
      } catch (e) {
        ok = false;
        reason = reasonOf(e);
      }
      if (ok && expectOk) {
        const tx = await fn(...args);
        await tx.wait();
        reason = tx.hash;
        if (asset === "ETH") ethPaid += ethFor81;
        else usdcPaid += usdc6(amount);
      }
      const pass = ok === expectOk;
      if (!pass) failures++;
      rows.push({
        wallet: i,
        buy: `${asset} $${amount}`,
        expected: expectOk ? "success" : "revert",
        actual: ok ? "success" : "revert",
        result: pass ? "PASS" : "FAIL",
        note: reason,
      });
    }
  }

  console.table(rows);

  // The money must have gone to the treasury at once; the presale contract must hold nothing.
  // (These checks assume no round sold out during the test, so no partial fill happened.)
  const tUsdc1 = await usdcRead.balanceOf(treasury);
  const tEth1 = await ethers.provider.getBalance(treasury);
  const pUsdc = await usdcRead.balanceOf(PRESALE);
  const pEth = await ethers.provider.getBalance(PRESALE);
  const checks = [
    ["treasury received exactly the USDC paid", tUsdc1 - tUsdc0 === usdcPaid],
    ["treasury received exactly the ETH paid", tEth1 - tEth0 === ethPaid],
    ["presale contract holds no USDC", pUsdc === 0n],
    ["presale contract holds no ETH", pEth === 0n],
  ];
  console.log(`treasury: ${treasury}`);
  console.log(`USDC paid by buyers: ${ethers.formatUnits(usdcPaid, 6)} | treasury USDC change: ${ethers.formatUnits(tUsdc1 - tUsdc0, 6)}`);
  console.log(`ETH paid by buyers: ${ethers.formatEther(ethPaid)} | treasury ETH change: ${ethers.formatEther(tEth1 - tEth0)}`);
  console.table(checks.map(([name, okc]) => ({ check: name, result: okc ? "PASS" : "FAIL" })));
  for (const [, okc] of checks) if (!okc) failures++;

  let sum = 0n;
  for (let i = 0; i < N; i++) {
    const a = wallets[i].address;
    const [bought, spent] = await Promise.all([presale.purchased(a), presale.spentUsd(a)]);
    sum += bought;
    console.log(`wallet ${i}: ${ethers.formatEther(bought)} ODX, spent $${ethers.formatEther(spent)}`);
  }
  const soldAfter = await presale.totalSold();
  console.log(`totalSold delta: ${ethers.formatEther(soldAfter - soldBefore)} ODX`);
  console.log(`sum of these wallets: ${ethers.formatEther(sum)} ODX`);
  console.log(failures === 0 ? "\nALL EXPECTATIONS MET" : `\n${failures} UNEXPECTED RESULT(S)`);
  if (failures) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

