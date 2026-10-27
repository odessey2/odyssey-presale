require("dotenv").config();
const { ethers } = require("hardhat");

async function main() {
  const [d] = await ethers.getSigners();
  const p = ethers.provider;
  console.log("Deployer:", d.address);
  console.log("ETH balance:", ethers.formatEther(await p.getBalance(d.address)));
  console.log("Next nonce:", await p.getTransactionCount(d.address, "latest"));
  const abi = [
    "function symbol() view returns (string)",
    "function balanceOf(address) view returns (uint256)",
  ];
  for (let n = 0; n < 40; n++) {
    const a = ethers.getCreateAddress({ from: d.address, nonce: n });
    const code = await p.getCode(a);
    if (code === "0x") continue;
    let info = "";
    try {
      const c = new ethers.Contract(a, abi, p);
      const sym = await c.symbol();
      const bal = await c.balanceOf(d.address);
      info = " symbol=" + sym + " deployerBalance=" + ethers.formatEther(bal);
    } catch (e) {}
    console.log("nonce", n, a, "codeBytes=" + (code.length - 2) / 2 + info);
  }
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
