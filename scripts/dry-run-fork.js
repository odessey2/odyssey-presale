// scripts/dry-run-fork.js
// Full dry run of scripts/deploy.js on a LOCAL fork of Ethereum mainnet, followed by real-looking purchases.
// Nothing is sent to the real network. Run in PowerShell, from the project folder:
//   $env:FORK="1"
//   npx hardhat run scripts/dry-run-fork.js
//   Remove-Item Env:FORK
// Needs MAINNET_RPC_URL in .env. FORK_BLOCK must NOT be set (an old block makes the real price feeds look stale).
require("dotenv").config();
if (process.env.FORK !== "1") {
  throw new Error('Run with FORK=1. In PowerShell:  $env:FORK="1"   and then   npx hardhat run scripts/dry-run-fork.js');
}
if (process.env.FORK_BLOCK) {
  throw new Error("Remove (or comment out) FORK_BLOCK in .env for this dry run: an old block makes the real price feeds look stale.");
}
process.env.FORK_DRY_RUN = "1";
process.env.DEPLOY_NO_AUTORUN = "1";
// the presale starts 10 minutes after the deployment, so the real price feeds are still fresh when we buy
process.env.PRESALE_START_UNIX = String(Math.floor(Date.now() / 1000) + 600);

const { ethers, network } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const { main } = require("./deploy.js");

const E = (n) => ethers.parseEther(String(n));
const U = (n) => BigInt(n) * 10n ** 6n;

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function approve(address,uint256)", // no return value on purpose: USDT does not return one
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
];
const FEED_ABI = [
  "function description() view returns (string)",
  "function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)",
];
const SAFE_ABI = [
  "function getThreshold() view returns (uint256)",
  "function getOwners() view returns (address[])",
  "function VERSION() view returns (string)",
];
const ALLOC = { "Team": 210_000_000, "DAO treasury": 225_000_000, "Strategic reserve": 75_000_000, "Advisors": 45_000_000 };
const WALLET_VARS = [
  "TREASURY_MULTISIG", "LIQUIDITY_WALLET", "ECOSYSTEM_WALLET", "SECURITY_RESERVE_WALLET",
  "TEAM_WALLET", "DAO_TREASURY_WALLET", "STRATEGIC_WALLET", "ADVISORS_WALLET",
];

// Give a wallet some USDC/USDT on the fork by writing its balance directly into the token's storage.
// The storage slot differs per token, so we try a few and keep the one where balanceOf() shows the amount.
async function fundToken(tokenAddr, holder, amount, slots) {
  const t = await ethers.getContractAt(ERC20_ABI, tokenAddr);
  for (const slot of slots) {
    const key = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["address", "uint256"], [holder, slot]));
    await network.provider.send("hardhat_setStorageAt", [
      tokenAddr, ethers.toQuantity(key), ethers.zeroPadValue(ethers.toBeHex(amount), 32),
    ]);
    if ((await t.balanceOf(holder)) === amount) return true;
  }
  return false;
}

const checks = [];
function add(name, status, detail = "") {
  const result = status === "SKIP" ? "SKIP" : status ? "PASS" : "FAIL";
  checks.push({ check: name, result, detail: String(detail) });
}

async function go() {
  const [deployer, buyer1, buyer2, buyer3] = await ethers.getSigners();
  // the default Hardhat test accounts are public; bots often delegate them (EIP-7702) on the real chain. Reset it on the fork.
  await network.provider.send("hardhat_setCode", [deployer.address, "0x"]);

  // ---- rules that apply to the real mainnet deployment
  console.log("\n== Wallet rules for the real mainnet deployment ==");
  if (process.env.DEPLOYER_PRIVATE_KEY) {
    try {
      const real = new ethers.Wallet(process.env.DEPLOYER_PRIVATE_KEY).address.toLowerCase();
      const clash = WALLET_VARS.filter((n) => (process.env[n] || "").toLowerCase() === real);
      add("No wallet in .env equals your real deployer address", clash.length === 0, clash.join(", "));
    } catch {
      add("Real deployer address check", "SKIP", "DEPLOYER_PRIVATE_KEY in .env could not be read");
    }
  } else {
    add("Real deployer address check", "SKIP", "DEPLOYER_PRIVATE_KEY is not set in .env");
  }
  const seen = {};
  for (const n of WALLET_VARS) {
    const a = (process.env[n] || "").toLowerCase();
    if (a) (seen[a] = seen[a] || []).push(n);
  }
  for (const names of Object.values(seen)) {
    if (names.length > 1) console.warn("WARNING: the same address is used for:", names.join(", "));
  }

  // ---- run the real deploy script on the fork
  const before = await ethers.provider.getBalance(deployer.address);
  const d = await main();
  const after = await ethers.provider.getBalance(deployer.address);
  console.log(`\nDeployment cost on this fork: about ${ethers.formatEther(before - after)} ETH at the fork's current gas price`);

  console.log("\n== Wallets from .env ==");
  for (const [name, addr] of Object.entries(d.wallets)) {
    const code = await ethers.provider.getCode(addr);
    console.log(`${name}: ${addr} (${code === "0x" ? "plain wallet" : "contract, e.g. a Safe"})`);
  }

  const { token, presale } = d;
  const w = d.wallets;
  const safeAddr = w.treasuryMultisig;

  // ---- deployment checks
  add("presale.treasury() is TREASURY_MULTISIG", ethers.getAddress(await presale.treasury()) === ethers.getAddress(safeAddr));
  add("USDC address in presale is the official one", ethers.getAddress(await presale.usdc()) === ethers.getAddress(d.feeds.usdc), d.feeds.usdc);
  add("USDT address in presale is the official one", ethers.getAddress(await presale.usdt()) === ethers.getAddress(d.feeds.usdt), d.feeds.usdt);
  try {
    const safe = await ethers.getContractAt(SAFE_ABI, safeAddr);
    const [threshold, owners, version] = await Promise.all([safe.getThreshold(), safe.getOwners(), safe.VERSION()]);
    add("Treasury is a Safe", true, `version ${version}, ${owners.length} owners, threshold ${threshold}`);
  } catch {
    add("Treasury is a Safe", false, "getThreshold/getOwners failed: is this address really a Safe on mainnet?");
  }
  add("Total supply is 1,500,000,000 ODX", (await token.totalSupply()) === E(1_500_000_000));
  add("Presale holds 300,000,000 ODX", (await token.balanceOf(d.presaleAddr)) === E(300_000_000));
  add("Deployer holds 0 ODX", (await token.balanceOf(deployer.address)) === 0n);
  for (const [label, amount] of Object.entries(ALLOC)) {
    const a = d.vestings[label];
    add(`${label} vesting holds ${amount.toLocaleString("en-US")} ODX`, !!a && (await token.balanceOf(a)) === E(amount));
  }
  const usdcT = await ethers.getContractAt(ERC20_ABI, d.feeds.usdc);
  const usdtT = await ethers.getContractAt(ERC20_ABI, d.feeds.usdt);
  add("USDC: symbol USDC, 6 decimals", (await usdcT.symbol()) === "USDC" && (await usdcT.decimals()) === 6n);
  add("USDT: symbol USDT, 6 decimals", (await usdtT.symbol()) === "USDT" && (await usdtT.decimals()) === 6n);

  // ---- price feeds
  const now = BigInt(await time.latest());
  const feedInfo = {};
  for (const [label, key, maxAge, word] of [
    ["ETH/USD", "ethUsdFeed", 2 * 3600, "ETH"],
    ["USDC/USD", "usdcUsdFeed", 25 * 3600, "USDC"],
    ["USDT/USD", "usdtUsdFeed", 25 * 3600, "USDT"],
  ]) {
    const f = await ethers.getContractAt(FEED_ABI, await presale[key]());
    const [, answer, , updatedAt] = await f.latestRoundData();
    const desc = await f.description();
    const age = now - updatedAt;
    feedInfo[key] = answer;
    // the purchases below happen about 10-15 minutes later, so leave some room
    const fresh = answer > 0n && age >= 0n && age + 900n < BigInt(maxAge);
    add(`${label} feed ("${desc}"): price ${Number(answer) / 1e8}, age ${age}s`, fresh && desc.toUpperCase().includes(word));
  }

  // ---- purchases (the presale starts 10 minutes after the deployment)
  await time.increaseTo(d.startTime);
  const price0 = await presale.priceOf(0);

  try {
    const priceEth = feedInfo.ethUsdFeed;
    const value = (E(100) * 10n ** 8n) / priceEth; // about $100
    const safeBefore = await ethers.provider.getBalance(safeAddr);
    await presale.connect(buyer1).buyWithETH(0, { value });
    add("ETH purchase: the Safe received exactly the ETH sent", (await ethers.provider.getBalance(safeAddr)) - safeBefore === value);
    add("ETH purchase: the presale contract holds no ETH", (await ethers.provider.getBalance(d.presaleAddr)) === 0n);
    const usd18 = (value * priceEth) / 10n ** 8n;
    add("ETH purchase: buyer credited the right amount of ODX", (await presale.purchased(buyer1.address)) === (usd18 * 10n ** 18n) / price0);
  } catch (e) {
    add("ETH purchase", false, e.shortMessage || e.message);
  }

  async function tokenBuy(label, tokenAddr, feedKey, buyer, slots) {
    try {
      const funded = await fundToken(tokenAddr, buyer.address, U(1000), slots);
      if (!funded) {
        add(`${label} purchase`, "SKIP", `could not give the test wallet ${label} on the fork (storage slot unknown)`);
        return;
      }
      const t = await ethers.getContractAt(ERC20_ABI, tokenAddr, buyer);
      await (await t.approve(d.presaleAddr, U(1000))).wait();
      const tt = await ethers.getContractAt(ERC20_ABI, tokenAddr);
      const safeBefore = await tt.balanceOf(safeAddr);
      await presale.connect(buyer).buyWithToken(tokenAddr, U(100), 0);
      add(`${label} purchase: the Safe received exactly 100`, (await tt.balanceOf(safeAddr)) - safeBefore === U(100));
      add(`${label} purchase: the presale contract holds no ${label}`, (await tt.balanceOf(d.presaleAddr)) === 0n);
      const p = feedInfo[feedKey] > 10n ** 8n ? 10n ** 8n : feedInfo[feedKey];
      const usd18 = (U(100) * 10n ** 12n * p) / 10n ** 8n;
      add(`${label} purchase: buyer credited the right amount of ODX`, (await presale.purchased(buyer.address)) === (usd18 * 10n ** 18n) / price0);
    } catch (e) {
      add(`${label} purchase`, false, e.shortMessage || e.message);
    }
  }
  await tokenBuy("USDC", d.feeds.usdc, "usdcUsdFeed", buyer2, [9n, 1n, 2n, 0n]);
  await tokenBuy("USDT", d.feeds.usdt, "usdtUsdFeed", buyer3, [2n, 1n, 0n, 3n, 4n]);

  console.log("\n== Results ==");
  console.table(checks);
  const failed = checks.filter((c) => c.result === "FAIL").length;
  const skipped = checks.filter((c) => c.result === "SKIP").length;
  console.log(failed === 0 ? `DRY RUN OK (${skipped} skipped)` : `${failed} CHECK(S) FAILED`);
  if (failed) process.exitCode = 1;
}

go().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
