require("dotenv").config();
const { ethers } = require("hardhat");

async function main() {
  const need = (n) => {
    const v = process.env[n];
    if (!v) throw new Error("Set " + n + " in .env");
    return v.toLowerCase();
  };
  const usdcAddr = need("USDC_ADDRESS");
  const presaleAddr = need("PRESALE_ADDRESS");
  const expectedTreasury = need("TREASURY_MULTISIG");

  const erc = ["function balanceOf(address) view returns (uint256)"];
  const usdc = await ethers.getContractAt(erc, usdcAddr);
  const presale = await ethers.getContractAt("OdysseyPresale", presaleAddr);

  const treasury = await presale.treasury();
  console.log("treasury inside the presale contract:", treasury);
  console.log("same as TREASURY_MULTISIG in .env:", treasury.toLowerCase() === expectedTreasury ? "YES" : "NO <-- WRONG");
  console.log("USDC balance of treasury (Safe):", ethers.formatUnits(await usdc.balanceOf(treasury), 6));
  console.log("ETH balance of treasury (Safe):", ethers.formatEther(await ethers.provider.getBalance(treasury)));
  console.log("USDC balance of the presale contract (should be 0):", ethers.formatUnits(await usdc.balanceOf(presaleAddr), 6));
  console.log("ETH balance of the presale contract (should be 0):", ethers.formatEther(await ethers.provider.getBalance(presaleAddr)));
  console.log("total sold:", ethers.formatEther(await presale.totalSold()), "ODX");

  const buyer = process.env.BUYER;
  if (buyer && ethers.isAddress(buyer.toLowerCase())) {
    const b = ethers.getAddress(buyer.toLowerCase());
    console.log("buyer", b);
    console.log("  bought:", ethers.formatEther(await presale.purchased(b)), "ODX");
    console.log("  spent:", ethers.formatEther(await presale.spentUsd(b)), "USD");
    console.log("  USDC left:", ethers.formatUnits(await usdc.balanceOf(b), 6));
  }
}

main().catch((e) => { console.error(e); process.exitCode = 1; });