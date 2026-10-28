// Usage: npx hardhat run scripts/deploy.js --network sepolia
// Mainnet: only after an audit, and after a full dry run (scripts/dry-run-fork.js).
require("dotenv").config();
const { ethers, network } = require("hardhat");

const E = (n) => ethers.parseEther(String(n));
const MONTH = 30 * 24 * 3600;
// FORK_DRY_RUN=1 is set only by scripts/dry-run-fork.js: a local fork of mainnet is treated exactly like mainnet
const FORK_DRY_RUN = process.env.FORK_DRY_RUN === "1" && network.name === "hardhat";
const IS_MAINNET = network.name === "mainnet" || FORK_DRY_RUN;

// Chainlink + token addresses on Ethereum mainnet. VERIFY each one on
// docs.chain.link and etherscan.io before deploying.
const MAINNET = {
  usdc: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  usdt: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
  ethUsdFeed: "0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419",
  usdcUsdFeed: "0x8fFfFfd4AfB6115b954Bd326cbe7B4BA576818f6",
  usdtUsdFeed: "0x3E7d1eAB13ad0104d2750B8863b489D65364e32D",
};

function need(name) {
  const v = process.env[name];
  if (!v || !ethers.isAddress(v)) throw new Error(`Set ${name} in .env to a valid address`);
  return v;
}

// deploy one contract and wait until it is mined before the next transaction is sent
async function deployWait(factory, ...args) {
  const c = await factory.deploy(...args);
  await c.waitForDeployment();
  return c;
}

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Network:", network.name, FORK_DRY_RUN ? "(local fork of mainnet, dry run)" : "", "| Deployer:", deployer.address);
  const bal = await ethers.provider.getBalance(deployer.address);
  console.log("Deployer ETH:", ethers.formatEther(bal));
  if (!IS_MAINNET && bal < ethers.parseEther("0.02")) {
    console.warn("WARNING: deployer has less than 0.02 ETH. The deployment may run out of gas half way.");
  }

  // An EIP-7702 delegated account has code that starts with 0xef0100
  const dCode = await ethers.provider.getCode(deployer.address);
  if (dCode.startsWith("0xef0100")) {
    const msg = "The deployer address is EIP-7702 delegated (it was upgraded to a smart account).";
    if (IS_MAINNET) throw new Error(msg + " Use a fresh, plain key for the mainnet deployment.");
    console.warn("WARNING (testnet only):", msg, "Transactions are sent one at a time.");
  }

  const w = {
    treasuryMultisig: need("TREASURY_MULTISIG"), // receives 100% of every payment, immediately (immutable after deploy)
    liquidityWallet: need("LIQUIDITY_WALLET"), // receives the 180M ODX liquidity allocation (lock the LP tokens!)
    ecosystem: need("ECOSYSTEM_WALLET"),
    security: need("SECURITY_RESERVE_WALLET"),
    team: need("TEAM_WALLET"),
    daoTreasury: need("DAO_TREASURY_WALLET"),
    strategic: need("STRATEGIC_WALLET"),
    advisors: need("ADVISORS_WALLET"),
  };
  const startTime = Number(process.env.PRESALE_START_UNIX);
  if (!startTime || startTime < Date.now() / 1000) throw new Error("Set PRESALE_START_UNIX in the future");

  // Mainnet-only safety checks
  if (IS_MAINNET) {
    const code = await ethers.provider.getCode(w.treasuryMultisig);
    if (code === "0x") {
      throw new Error("TREASURY_MULTISIG has no contract code on mainnet. Is it a real Safe on THIS network?");
    }
    for (const [label, addr] of Object.entries(w)) {
      if (addr.toLowerCase() === deployer.address.toLowerCase()) {
        throw new Error(`${label} is the deployer address. Not allowed on mainnet.`);
      }
    }
  }

  let feeds = MAINNET;
  if (!IS_MAINNET) {
    // testnets / local: deploy mocks (ETH = $3000)
    const Stable = await ethers.getContractFactory("MockStable");
    const Feed = await ethers.getContractFactory("MockFeed");
    const usdc = await deployWait(Stable, "USD Coin", "USDC");
    const usdt = await deployWait(Stable, "Tether", "USDT");
    const f1 = await deployWait(Feed, 3000n * 10n ** 8n);
    const f2 = await deployWait(Feed, 10n ** 8n);
    const f3 = await deployWait(Feed, 10n ** 8n);
    feeds = {
      usdc: await usdc.getAddress(), usdt: await usdt.getAddress(),
      ethUsdFeed: await f1.getAddress(), usdcUsdFeed: await f2.getAddress(), usdtUsdFeed: await f3.getAddress(),
    };
    console.log("Mocks deployed (testnet only):", feeds);
  }

  const token = await deployWait(await ethers.getContractFactory("OdysseyToken"), deployer.address);
  const tokenAddr = await token.getAddress();

  const presale = await deployWait(await ethers.getContractFactory("OdysseyPresale"), {
    token: tokenAddr,
    treasury: w.treasuryMultisig,
    startTime,
    ...feeds,
  });
  const presaleAddr = await presale.getAddress();

  const vestings = {};
  const Vesting = await ethers.getContractFactory("OdysseyVesting");
  async function vest(label, beneficiary, amount, cliffMonths, durationMonths) {
    const v = await deployWait(Vesting, tokenAddr, presaleAddr, beneficiary, cliffMonths * MONTH, durationMonths * MONTH);
    const vAddr = await v.getAddress();
    await (await token.transfer(vAddr, E(amount))).wait();
    vestings[label] = vAddr;
    console.log(`${label} vesting:`, vAddr);
  }

  // Allocation (whitepaper section 5). Months are 30 days.
  await (await token.transfer(presaleAddr, E(300_000_000))).wait(); // presale
  await (await token.transfer(w.ecosystem, E(375_000_000))).wait(); // ecosystem / airdrop
  await (await token.transfer(w.liquidityWallet, E(180_000_000))).wait(); // liquidity (lock the LP tokens!)
  await (await token.transfer(w.security, E(90_000_000))).wait(); // security reserve
  await vest("Team", w.team, 210_000_000, 6, 12);
  await vest("DAO treasury", w.daoTreasury, 225_000_000, 6, 48);
  await vest("Strategic reserve", w.strategic, 75_000_000, 6, 24);
  await vest("Advisors", w.advisors, 45_000_000, 6, 18);

  const left = await token.balanceOf(deployer.address);
  if (left !== 0n) {
    const msg = "Deployer still holds tokens: " + ethers.formatEther(left) + " ODX";
    if (IS_MAINNET) throw new Error(msg);
    console.warn("WARNING (allowed on testnet only):", msg);
  }

  console.log("\nToken:  ", tokenAddr);
  console.log("Presale:", presaleAddr);
  console.log("Treasury (gets 100% of every payment at once):", w.treasuryMultisig);
  console.log("Liquidity wallet (gets 180M ODX):", w.liquidityWallet);
  console.log("Next: verify all contracts on Etherscan and publish the addresses.");

  return { token, presale, tokenAddr, presaleAddr, wallets: w, vestings, startTime, feeds };
}

module.exports = { main };

// scripts/dry-run-fork.js sets DEPLOY_NO_AUTORUN=1 so that it can call main() itself and then check the result
if (process.env.DEPLOY_NO_AUTORUN !== "1") {
  main().catch((e) => { console.error(e); process.exitCode = 1; });
}