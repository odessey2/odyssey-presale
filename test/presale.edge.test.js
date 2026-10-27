const { expect } = require("chai");
const { ethers, network } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

const E = ethers.parseEther;
const U = (n) => BigInt(n) * 10n ** 6n;
const DAY = 86400;

async function deploy() {
  const [deployer, treasury, alice] = await ethers.getSigners();
  const token = await (await ethers.getContractFactory("OdysseyToken")).deploy(deployer.address);
  const Stable = await ethers.getContractFactory("MockStable");
  const Feed = await ethers.getContractFactory("MockFeed");
  const usdc = await Stable.deploy("USDC", "USDC");
  const usdt = await Stable.deploy("USDT", "USDT");
  const ethFeed = await Feed.deploy(3000n * 10n ** 8n);
  const usdcFeed = await Feed.deploy(10n ** 8n);
  const usdtFeed = await Feed.deploy(10n ** 8n);
  const start = (await time.latest()) + 1000;
  const presale = await (await ethers.getContractFactory("OdysseyPresale")).deploy({
    token: await token.getAddress(),
    treasury: treasury.address,
    startTime: start,
    usdc: await usdc.getAddress(),
    usdt: await usdt.getAddress(),
    ethUsdFeed: await ethFeed.getAddress(),
    usdcUsdFeed: await usdcFeed.getAddress(),
    usdtUsdFeed: await usdtFeed.getAddress(),
  });
  const presaleAddr = await presale.getAddress();
  await token.transfer(presaleAddr, E("300000000"));
  for (const s of [usdc, usdt]) {
    await s.mint(alice.address, U(10000));
    await s.connect(alice).approve(presaleAddr, ethers.MaxUint256);
  }
  return { deployer, treasury, token, presale, usdc, usdt, ethFeed, usdcFeed, usdtFeed, alice, start };
}

describe("OdysseyPresale edge cases", () => {
  it("price schedule and round caps add up", async () => {
    const { presale } = await loadFixture(deploy);
    expect(await presale.priceOf(0)).to.equal(E("0.008"));
    expect(await presale.priceOf(16)).to.equal(E("0.07"));
    let sum = 0n;
    for (let i = 0; i < 17; i++) sum += await presale.roundCap(i);
    expect(sum).to.equal(E("300000000"));
  });

  it("partially fills a round that sells out, returns the excess and starts the next round at once", async function () {
    this.timeout(300000);
    const { presale, treasury, start } = await loadFixture(deploy);
    await time.increaseTo(start);
    const addr = await presale.getAddress();
    const newBuyer = async () => {
      const w = ethers.Wallet.createRandom().connect(ethers.provider);
      await network.provider.send("hardhat_setBalance", [w.address, "0x56BC75E2D63100000"]);
      return w;
    };
    for (let i = 0; i < 201; i++) {
      const w = await newBuyer();
      await presale.connect(w).buyWithETH(0n, { value: E("0.2333") }); // ~$699.9
    }
    const state = await presale.saleState();
    expect(state[0]).to.equal(0n);
    const remaining = state[2];

    const last = await newBuyer();
    const before = await ethers.provider.getBalance(treasury.address);
    await presale.connect(last).buyWithETH(0n, { value: E("0.2333") });
    const paid = (await ethers.provider.getBalance(treasury.address)) - before;
    expect(await presale.purchased(last.address)).to.equal(remaining);
    expect(paid).to.be.gt(E("0.15"));
    expect(paid).to.be.lt(E("0.17")); // the rest of the 0.2333 ETH was returned to the buyer
    expect(await ethers.provider.getBalance(addr)).to.equal(0n); // the presale contract holds no money

    expect((await presale.saleState())[0]).to.equal(1n); // round 2 started immediately
    await presale.connect(last).buyWithETH(0n, { value: E("0.034") }); // $102 at $0.011875
    const gained = (await presale.purchased(last.address)) - remaining;
    expect(gained).to.be.gt(E("8500"));
    expect(gained).to.be.lt(E("8600"));
    expect(await ethers.provider.getBalance(addr)).to.equal(0n);
  });

  it("accepts USDT and rejects other tokens", async () => {
    const { presale, token, usdt, alice, start } = await loadFixture(deploy);
    await time.increaseTo(start);
    await presale.connect(alice).buyWithToken(await usdt.getAddress(), U(80), 0n);
    expect(await presale.purchased(alice.address)).to.equal(E("10000"));
    await expect(presale.connect(alice).buyWithToken(await token.getAddress(), U(100), 0n)).to.be.revertedWith("asset not accepted");
  });

  it("rejects stale or invalid prices", async () => {
    const { presale, ethFeed, usdcFeed, usdc, alice, start } = await loadFixture(deploy);
    await time.increaseTo(start);
    await ethFeed.setStale(1);
    await expect(presale.connect(alice).buyWithETH(0n, { value: E("0.034") })).to.be.revertedWith("stale price");
    await usdcFeed.set(0);
    await expect(presale.connect(alice).buyWithToken(await usdc.getAddress(), U(100), 0n)).to.be.revertedWith("bad price");
  });

  it("credits a depegged stablecoin at its lower price and never above $1", async () => {
    const { presale, usdcFeed, usdc, alice, start } = await loadFixture(deploy);
    await time.increaseTo(start);
    await usdcFeed.set(90_000_000n); // $0.90
    await presale.connect(alice).buyWithToken(await usdc.getAddress(), U(700), 0n); // credited $630
    expect(await presale.purchased(alice.address)).to.equal(E("78750"));
    await time.increase(12 * DAY + 1);
    await usdcFeed.set(110_000_000n); // $1.10, capped to $1
    await presale.connect(alice).buyWithToken(await usdc.getAddress(), U(100), 0n); // credited $100 at round 2
    const gained = (await presale.purchased(alice.address)) - E("78750");
    expect(gained).to.be.gt(E("8421"));
    expect(gained).to.be.lt(E("8422"));
  });

  it("rejects direct ETH transfers", async () => {
    const { presale, alice } = await loadFixture(deploy);
    await expect(alice.sendTransaction({ to: await presale.getAddress(), value: 1n })).to.be.reverted;
  });

  it("cannot claim before the end, and non-buyers have nothing to claim", async () => {
    const { presale, alice, deployer, start } = await loadFixture(deploy);
    await time.increaseTo(start);
    await expect(presale.connect(alice).claim()).to.be.revertedWith("presale not ended");
    await time.increaseTo(start + 17 * 12 * DAY + 5);
    await expect(presale.connect(deployer).claim()).to.be.revertedWith("nothing to claim");
  });

  it("vests linearly after presale end + cliff", async () => {
    const { token, presale, alice, start } = await loadFixture(deploy);
    const vest = await (await ethers.getContractFactory("OdysseyVesting")).deploy(
      await token.getAddress(), await presale.getAddress(), alice.address, 180 * DAY, 360 * DAY
    );
    await token.transfer(await vest.getAddress(), E("1000000"));
    expect(await vest.releasable()).to.equal(0n); // presale not ended yet
    const end = start + 17 * 12 * DAY;
    await time.increaseTo(end + 180 * DAY - 100);
    expect(await vest.releasable()).to.equal(0n); // still inside the cliff
    await time.increaseTo(end + 180 * DAY + 180 * DAY); // half way
    const half = await vest.releasable();
    expect(half).to.be.gt(E("499000"));
    expect(half).to.be.lt(E("501000"));
    await vest.release();
    await time.increase(400 * DAY);
    await vest.release();
    expect(await token.balanceOf(alice.address)).to.equal(E("1000000"));
    await expect(vest.release()).to.be.revertedWith("nothing to release");
  });
});
