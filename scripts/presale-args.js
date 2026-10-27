require("dotenv").config();
module.exports = [
  {
    token: "0xE3D3c591545A0B17837c57B493590a4642C37932",
    treasury: process.env.TREASURY_MULTISIG,
    liquidityWallet: process.env.LIQUIDITY_WALLET,
    startTime: process.env.PRESALE_START_UNIX,
    usdc: "0x1E7f92a0b47149150aFf15247c57b94C5e707930",
    usdt: "0xC466a0ea7100a34aF81a18F3530CcFcd462ae8Ee",
    ethUsdFeed: "0x059CFA3B143A46Fa180342BBee8C9DCc14ecf359",
    usdcUsdFeed: "0xb6d0c6b41D3Cf97c2FFe0DB91FD476C2a3d3dcC2",
    usdtUsdFeed: "0x8eA7C7Ac60Df0563fD192F5F8eE5dF91554bae05",
  },
];
