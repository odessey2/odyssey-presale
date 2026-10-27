// Read-only. Checks the mainnet addresses in scripts/deploy.js against Chainlink ENS names and on-chain data.
require("dotenv").config();
const { ethers } = require("ethers");
const fs = require("fs");
const path = require("path");

const src = fs.readFileSync(path.join(__dirname, "deploy.js"), "utf8");
const block = src.match(/const MAINNET = \{([\s\S]*?)\};/)[1];
const get = (k) => {
  const m = block.match(new RegExp(k + ':\\s*"(0x[0-9a-fA-F]{40})"'));
  if (!m) throw new Error("address " + k + " not found in deploy.js");
  return m[1];
};
const A = {
  usdc: get("usdc"), usdt: get("usdt"),
  ethUsdFeed: get("ethUsdFeed"), usdcUsdFeed: get("usdcUsdFeed"), usdtUsdFeed: get("usdtUsdFeed"),
};

const FEED = [
  "function decimals() view returns (uint8)",
  "function description() view returns (string)",
  "function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)",
];
const TOKEN = [
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
];

async function main() {
  const url = process.env.MAINNET_RPC_URL;
  if (!url) throw new Error("Set MAINNET_RPC_URL in .env");
  const p = new ethers.JsonRpcProvider(url);
  const net = await p.getNetwork();
  console.log("chainId:", net.chainId.toString(), net.chainId === 1n ? "(Ethereum mainnet, OK)" : "<-- NOT MAINNET");
  const now = Math.floor(Date.now() / 1000);
  let problems = 0;

  const feeds = [
    ["ethUsdFeed", "eth-usd.data.eth", "ETH / USD"],
    ["usdcUsdFeed", "usdc-usd.data.eth", "USDC / USD"],
    ["usdtUsdFeed", "usdt-usd.data.eth", "USDT / USD"],
  ];
  for (const [key, ens, desc] of feeds) {
    console.log("\n" + key + ": " + A[key]);
    let resolved = null;
    try { resolved = await p.resolveName(ens); } catch (e) { /* handled below */ }
    if (!resolved) {
      console.log("  ENS " + ens + ": could not resolve. Check the name on docs.chain.link/data-feeds/ens");
      problems++;
    } else {
      const same = resolved.toLowerCase() === A[key].toLowerCase();
      console.log("  ENS " + ens + " ->", resolved, same ? "MATCH" : "DIFFERENT <-- STOP");
      if (!same) problems++;
    }
    const f = new ethers.Contract(A[key], FEED, p);
    const [dec, d, r] = await Promise.all([f.decimals(), f.description(), f.latestRoundData()]);
    console.log("  decimals:", dec.toString(), "| description:", d, d.trim() === desc ? "OK" : "<-- expected " + desc);
    console.log("  price: $" + Number(r[1]) / 1e8, "| age:", Math.floor((now - Number(r[3])) / 60), "minutes");
    if (dec !== 8n || d.trim() !== desc) problems++;
  }

  for (const key of ["usdc", "usdt"]) {
    const t = new ethers.Contract(A[key], TOKEN, p);
    const [n, s, dec] = await Promise.all([t.name(), t.symbol(), t.decimals()]);
    console.log("\n" + key + ": " + A[key]);
    console.log("  name:", n, "| symbol:", s, "| decimals:", dec.toString());
    if (dec !== 6n) problems++;
  }

  console.log("\nCompare the USDC and USDT addresses above by eye with the official pages:");
  console.log("  Circle: developers.circle.com/stablecoins/usdc-contract-addresses");
  console.log("  Tether: tether.to/en/supported-protocols");
  console.log(problems === 0 ? "\nAUTOMATIC CHECKS PASSED" : "\n" + problems + " PROBLEM(S) FOUND");
  if (problems) process.exitCode = 1;
}

main().catch((e) => { console.error(String(e.message || e).replace(/https?:\/\/\S+/g, "<url hidden>")); process.exitCode = 1; });