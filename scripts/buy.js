require("dotenv").config();
const { ethers } = require("hardhat");

const PRESALE = "0x736007C4f9feAb366a1F42d5a76f84273A1D49E6";

async function main() {
  const [d] = await ethers.getSigners();
  const p = await ethers.getContractAt("OdysseyPresale", PRESALE);
  const f = (x) => ethers.formatEther(x);

  const bal = await ethers.provider.getBalance(d.address);
  const now = (await ethers.provider.getBlock("latest")).timestamp;
  const start = await p.startTime();
  console.log("Buyer:", d.address, "| ETH balance:", f(bal));
  console.log("Presale started:", now >= Number(start));

  const s = await p.saleState();
  console.log("Round (0-based):", s[0].toString(), "| price USD:", f(s[1]), "| remaining ODX:", f(s[2]), "| ended:", s[4]);
  console.log("Allowance left USD:", f(await p.remainingAllowanceUsd(d.address)));

  const value = ethers.parseEther("0.0267"); // about $80.10 at the mock price of $3000
  if (bal < value + ethers.parseEther("0.003")) {
    throw new Error("Not enough ETH for the purchase plus gas. Get more SepoliaETH.");
  }

  const tx = await p.buyWithETH({ value });
  console.log("Tx sent:", tx.hash);
  await tx.wait();

  console.log("Purchased ODX:", f(await p.purchased(d.address)));
  console.log("Spent USD:", f(await p.spentUsd(d.address)));
  console.log("Total sold:", f(await p.totalSold()));
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
