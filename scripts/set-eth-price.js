// TESTNET ONLY. Changes the price of the mock ETH/USD feed of the current presale deployment.
// Usage (PowerShell):
//   $env:ETH_PRICE="100000"
//   npx hardhat run scripts/set-eth-price.js --network sepolia
require("dotenv").config();
const { ethers, network } = require("hardhat");

async function main() {
  if (network.name === "mainnet") throw new Error("Testnet only");
  const presaleAddr = process.env.PRESALE_ADDRESS;
  if (!presaleAddr) throw new Error("Set PRESALE_ADDRESS in .env");
  const price = BigInt(process.env.ETH_PRICE || "3000");
  if (price < 1n || price > 1000000n) throw new Error("ETH_PRICE must be between 1 and 1000000");

  const [signer] = await ethers.getSigners();
  const presale = await ethers.getContractAt("OdysseyPresale", presaleAddr);
  const feedAddr = await presale.ethUsdFeed();
  const feed = await ethers.getContractAt("MockFeed", feedAddr, signer);

  // a real Chainlink feed has no answer(): this line fails if the feed is not a mock
  const before = await feed.answer();
  console.log("mock feed:", feedAddr);
  console.log("price before: $" + (Number(before) / 1e8));

  await (await feed.set(price * 10n ** 8n)).wait();
  console.log("price after:  $" + (Number(await feed.answer()) / 1e8));
}

main().catch((e) => { console.error(e); process.exitCode = 1; });