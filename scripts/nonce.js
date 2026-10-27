const { ethers } = require("hardhat");

async function main() {
  const a = "0x49a700FBB4C9F3e7f6cA426fE22D458381F0A107";
  const latest = await ethers.provider.getTransactionCount(a, "latest");
  const pending = await ethers.provider.getTransactionCount(a, "pending");
  console.log("latest:", latest, "pending:", pending);
}

main().catch((e) => { console.error(e); process.exit(1); });
