const { expect } = require("chai");
const { ethers, network } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

// Runs only with FORK=1 (a local copy of Ethereum mainnet). No real money is used.
const suite = process.env.FORK === "1" ? describe : describe.skip;

// Mainnet addresses (same as in scripts/deploy.js). VERIFY them on official sources before mainnet.
const A = Object.fromEntries(
  Object.entries({
    usdc: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    usdt: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
    ethFeed: "0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419",
    usdcFeed: "0x8fFfFfd4AfB6115b954Bd326cbe7B4BA576818f6",
    usdtFeed: "0x3E7d1eAB13ad0104d2750B8863b489D65364e32D",
  }).map(([k, v]) => [k, v.toLowerCase()])
);

const E = ethers.parseEther;
const U = (n) => BigInt(n) * 10n ** 6n;
const ERC = [
  "function balanceOf(address) view returns (uint256)",
  "function approve(address,uint256)",
];
const FEED = ["function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)"];

// Gives a test wallet real USDC/USDT by finding the storage slot of the balance mapping.
async function setTokenBalance(tokenAddr, holder, amount) {
  const abi = ethers.AbiCoder.defaultAbiCoder();
  const token = new ethers.Contract(tokenAddr, ERC, ethers.provider);
  for (let slot = 0; slot < 40; slot++) {
    const key = ethers.keccak256(abi.encode(["address", "uint256"], [holder, slot]));
    const old = await ethers.provider.getStorage(tokenAddr, key);
    await network.provider.send("hardhat_setStorageAt", [
      tokenAddr,
      key,
      ethers.zeroPadValue(ethers.toBeHex(amount), 32),
    ]);
    if ((await token.balanceOf(holder)) === amount) return slot;
    await network.provider.send("hardhat_setStorageAt", [tokenAddr, key, old]);
  }
  throw new Error("balance slot not found for " + tokenAddr);
}

suite("Mainnet fork: presale with real USDC, USDT and Chainlink feeds", function () {
  this.timeout(600000);
  let presale, presaleAddr, usdc, usdt, buyer, treasury, start;

  before(async () => {
    const [deployer, b] = await ethers.getSigners();
    buyer = b;
    treasury = ethers.Wallet.createRandom().address; // fresh address, balance zero
    const token = await (await ethers.getContractFactory("OdysseyToken")).deploy(deployer.address);
    start = (await time.latest()) + 120;
    presale = await (await ethers.getContractFactory("OdysseyPresale")).deploy({
      token: await token.getAddress(),
      treasury,
      startTime: start,
      usdc: A.usdc,
      usdt: A.usdt,
      ethUsdFeed: A.ethFeed,
      usdcUsdFeed: A.usdcFeed,
      usdtUsdFeed: A.usdtFeed,
    });
    presaleAddr = await presale.getAddress();
    await token.transfer(presaleAddr, E("300000000"));

    usdc = new ethers.Contract(A.usdc, ERC, buyer);
    usdt = new ethers.Contract(A.usdt, ERC, buyer);
    await setTokenBalance(A.usdc, buyer.address, U(10000));
    await setTokenBalance(A.usdt, buyer.address, U(10000));
    await usdc.approve(presaleAddr, ethers.MaxUint256);
    await usdt.approve(presaleAddr, U(10000));
    await time.increaseTo(start);
  });

  it("the real feeds return sane prices (constructor checked their decimals)", async () => {
    const read = async (a) => (await new ethers.Contract(a, FEED, ethers.provider).latestRoundData())[1];
    const eth = await read(A.ethFeed);
    expect(eth).to.be.gt(100n * 10n ** 8n); // above $100
    expect(eth).to.be.lt(100000n * 10n ** 8n); // below $100,000
    for (const f of [A.usdcFeed, A.usdtFeed]) {
      const p = await read(f);
      expect(p).to.be.gt(95_000_000n); // above $0.95
      expect(p).to.be.lt(105_000_000n); // below $1.05
    }
  });

  it("buys with real USDC: the treasury receives exactly the amount and the presale holds none", async () => {
    const reader = new ethers.Contract(A.usdc, ERC, ethers.provider);
    const before = await reader.balanceOf(treasury);
    await presale.connect(buyer).buyWithToken(A.usdc, U(100), 0n);
    expect((await reader.balanceOf(treasury)) - before).to.equal(U(100));
    expect(await reader.balanceOf(presaleAddr)).to.equal(0n);
    const got = await presale.purchased(buyer.address);
    expect(got).to.be.lte(E("12500")); // $100 at $0.008, never more
    expect(got).to.be.gt(E("12400"));
  });

  it("buys with real USDT (non-standard token): the treasury receives exactly the amount", async () => {
    const reader = new ethers.Contract(A.usdt, ERC, ethers.provider);
    const before = await reader.balanceOf(treasury);
    const tokensBefore = await presale.purchased(buyer.address);
    await presale.connect(buyer).buyWithToken(A.usdt, U(100), 0n);
    // if USDT ever turns on a transfer fee, this line fails (finding F-04)
    expect((await reader.balanceOf(treasury)) - before).to.equal(U(100));
    expect(await reader.balanceOf(presaleAddr)).to.equal(0n);
    expect((await presale.purchased(buyer.address)) - tokensBefore).to.be.gt(E("12400"));
  });

  it("buys with ETH at the real price: the treasury receives the ETH and the presale holds none", async () => {
    const [, price] = await new ethers.Contract(A.ethFeed, FEED, ethers.provider).latestRoundData();
    const value = (100n * 10n ** 18n * 10n ** 8n) / price + 1n; // just over $100
    const before = await ethers.provider.getBalance(treasury);
    await presale.connect(buyer).buyWithETH(0n, { value });
    expect((await ethers.provider.getBalance(treasury)) - before).to.equal(value);
    expect(await ethers.provider.getBalance(presaleAddr)).to.equal(0n);
  });

  it("limits still hold with real tokens", async () => {
    await expect(presale.connect(buyer).buyWithToken(A.usdc, U(79), 0n)).to.be.revertedWith("below minimum");
    // $300 already spent in round 1, so $701 more is above the $700 round limit
    await expect(presale.connect(buyer).buyWithToken(A.usdc, U(701), 0n)).to.be.revertedWith("round limit");
  });

  it("accounting: totalSold equals the buyer's tokens and the presale still holds 300M ODX", async () => {
    expect(await presale.totalSold()).to.equal(await presale.purchased(buyer.address));
    const token = new ethers.Contract(await presale.token(), ERC, ethers.provider);
    expect(await token.balanceOf(presaleAddr)).to.equal(E("300000000"));
  });
});
