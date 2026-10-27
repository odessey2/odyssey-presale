// Testnet only. Gives test USDC (and optionally a little ETH) to a test wallet.
// Usage (PowerShell):
//   $env:BUYER="0xYourTestBuyerAddress"
//   npx hardhat run scripts/mint-usdc.js --network sepolia
require("dotenv").config();
const { ethers, network } = require("hardhat");

const USDC = "0x9389E3fE918eDcf1bb20a802Ec29A63DeCb825ff".toLowerCase(); // mock USDC of the current Sepolia deploy

async function main() {
  if (network.name === "mainnet") throw new Error("Testnet only");
  const raw = process.env.BUYER;
  if (!raw || !ethers.isAddress(raw.toLowerCase())) {
    throw new Error('Set BUYER first, e.g. $env:BUYER="0x..." (public address only)');
  }
  const to = ethers.getAddress(raw.toLowerCase());
  const [signer] = await ethers.getSigners();
  console.log("Network:", network.name);
  console.log("Sender (pays gas):", signer.address);
  console.log("Recipient:", to);

  const usdc = await ethers.getContractAt("MockStable", USDC, signer);
  const amount = ethers.parseUnits(process.env.AMOUNT || "1000", 6);
  await (await usdc.mint(to, amount)).wait();
  console.log("USDC balance of recipient:", ethers.formatUnits(await usdc.balanceOf(to), 6));

  if (process.env.SEND_ETH) {
    await (await signer.sendTransaction({ to, value: ethers.parseEther(process.env.SEND_ETH) })).wait();
    console.log("Sent ETH:", process.env.SEND_ETH);
  }
  console.log("ETH balance of recipient:", ethers.formatEther(await ethers.provider.getBalance(to)));
}

main().catch((e) => { console.error(e); process.exitCode = 1; });

