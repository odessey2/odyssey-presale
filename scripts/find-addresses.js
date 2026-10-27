require("dotenv").config();
const { ethers } = require("hardhat");

async function main() {
  const usdcEnv = process.env.USDC_ADDRESS;
  if (!usdcEnv || !ethers.isAddress(usdcEnv.toLowerCase())) {
    throw new Error("Set USDC_ADDRESS in .env to the mock USDC address of the deployment");
  }
  const usdc = usdcEnv.toLowerCase();

  const [d] = await ethers.getSigners();
  const last = await ethers.provider.getTransactionCount(d.address);

  let n0 = -1;
  for (let n = Math.max(0, last - 80); n < last; n++) {
    if (ethers.getCreateAddress({ from: d.address, nonce: n }).toLowerCase() === usdc) n0 = n;
  }
  if (n0 < 0) throw new Error("mock USDC not found in the last 80 transactions of the deployer");

  // deploy.js order: usdc, usdt, 3 feeds, token, presale
  const token = ethers.getCreateAddress({ from: d.address, nonce: n0 + 5 });
  const presale = ethers.getCreateAddress({ from: d.address, nonce: n0 + 6 });
  console.log("token:  ", token);
  console.log("presale:", presale);

  if ((await ethers.provider.getCode(presale)) === "0x") throw new Error("No contract at the presale address");

  const p = await ethers.getContractAt("OdysseyPresale", presale);
  const treasury = await p.treasury();
  console.log("treasury:", treasury);

  const expected = process.env.TREASURY_MULTISIG;
  if (expected) {
    console.log(
      "treasury matches TREASURY_MULTISIG in .env:",
      expected.toLowerCase() === treasury.toLowerCase() ? "YES" : "NO  <-- STOP, WRONG ADDRESS"
    );
  }
  const tCode = await ethers.provider.getCode(treasury);
  console.log(
    "treasury is a contract (e.g. a Safe):",
    tCode === "0x" ? "NO (plain wallet, one key)" : "YES"
  );

  const erc = ["function balanceOf(address) view returns (uint256)"];
  const tok = await ethers.getContractAt(erc, token);
  console.log("presale contract ETH balance (should be 0):", ethers.formatEther(await ethers.provider.getBalance(presale)));
  console.log("presale contract ODX balance (should be 300000000.0):", ethers.formatEther(await tok.balanceOf(presale)));
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});