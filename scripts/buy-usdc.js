require("dotenv").config();
const { ethers } = require("hardhat");

const PRESALE = "0x736007C4f9feAb366a1F42d5a76f84273A1D49E6";
const USDC = "0x1E7f92a0b47149150aFf15247c57b94C5e707930";

async function main() {
  const [d] = await ethers.getSigners();
  const p = await ethers.getContractAt("OdysseyPresale", PRESALE);
  const usdc = await ethers.getContractAt("MockStable", USDC);
  const f = (x) => ethers.formatEther(x);
  const u = (n) => BigInt(n) * 10n ** 6n;

  const bal = await ethers.provider.getBalance(d.address);
  console.log("ETH balance:", f(bal));
  if (bal < ethers.parseEther("0.01")) throw new Error("Need about 0.01 SepoliaETH for gas.");

  console.log("Minting 1000 mock USDC and approving...");
  await (await usdc.mint(d.address, u(1000))).wait();
  await (await usdc.approve(PRESALE, u(1000))).wait();

  async function expectRevert(label, amount) {
    try {
      await p.buyWithToken.staticCall(USDC, amount);
      console.log(label, "-> UNEXPECTEDLY SUCCEEDED (problem!)");
    } catch (e) {
      console.log(label, "-> rejected as expected:", e.reason || e.shortMessage || e.message);
    }
  }

  await expectRevert("Buy $79 (below $80 minimum)", u(79));

  console.log("Buying $100 with mock USDC...");
  const tx = await p.buyWithToken(USDC, u(100));
  console.log("Tx:", tx.hash);
  await tx.wait();

  console.log("Purchased ODX total:", f(await p.purchased(d.address)));
  console.log("Spent USD total:", f(await p.spentUsd(d.address)));
  console.log("Mock USDC left:", ethers.formatUnits(await usdc.balanceOf(d.address), 6));

  await expectRevert("Buy $650 more (over $700 round-1 cap)", u(650));
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
