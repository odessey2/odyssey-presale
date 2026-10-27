require("dotenv").config();
const { ethers } = require("hardhat");

const E = (n) => ethers.parseEther(String(n));
const MONTH = 30 * 24 * 3600;
const TOKEN = "0xE3D3c591545A0B17837c57B493590a4642C37932";
const PRESALE = "0x736007C4f9feAb366a1F42d5a76f84273A1D49E6";

async function main() {
  const [d] = await ethers.getSigners();
  const token = await ethers.getContractAt("OdysseyToken", TOKEN);
  const presale = await ethers.getContractAt("OdysseyPresale", PRESALE);

  if ((await token.symbol()) !== "ODX") throw new Error("Not the ODX token");
  if ((await presale.token()).toLowerCase() !== TOKEN.toLowerCase()) throw new Error("Presale token mismatch");
  const pb = await token.balanceOf(PRESALE);
  if (pb !== E(300_000_000)) throw new Error("Presale balance unexpected: " + pb);
  const db = await token.balanceOf(d.address);
  if (db < E(120_000_000)) throw new Error("Deployer has too few ODX: " + db);
  console.log("Checks OK. Deployer ODX:", ethers.formatEther(db));

  const Vesting = await ethers.getContractFactory("OdysseyVesting");
  async function vest(label, envName, amount, cliffMonths, durationMonths) {
    const b = process.env[envName];
    if (!ethers.isAddress(b)) throw new Error("Bad " + envName);
    const v = await Vesting.deploy(TOKEN, PRESALE, b, cliffMonths * MONTH, durationMonths * MONTH);
    await v.waitForDeployment();
    await (await token.transfer(await v.getAddress(), E(amount))).wait();
    console.log(label + " vesting:", await v.getAddress());
  }

  await vest("Strategic reserve", "STRATEGIC_WALLET", 75_000_000, 6, 24);
  await vest("Advisors", "ADVISORS_WALLET", 45_000_000, 6, 18);
  console.log("Done.");
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
