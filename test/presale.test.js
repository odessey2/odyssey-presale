const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

const E = ethers.parseEther;
const U = (n) => BigInt(n) * 10n ** 6n; // 6-decimal stablecoin amounts
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
  await token.transfer(await presale.getAddress(), E("300000000"));
  await usdc.mint(alice.address, U(10000));
  await usdc.connect(alice).approve(await presale.getAddress(), ethers.MaxUint256);
  return { token, presale, usdc, usdt, ethFeed, usdcFeed, usdtFeed, deployer, treasury, alice, start };
}

describe("OdysseyPresale", () => {
  it("rejects purchases before the start", async () => {
    const { presale, alice } = await loadFixture(deploy);
    await expect(presale.connect(alice).buyWithETH(0n, { value: E("0.034") })).to.be.revertedWith("not started");
  });

  it("sells at the round 1 price with ETH", async () => {
    const { presale, alice, start } = await loadFixture(deploy);
    await time.increaseTo(start);
    await presale.connect(alice).buyWithETH(0n, { value: E("0.034") }); // $102 at ETH=$3000
    expect(await presale.purchased(alice.address)).to.equal(E("12750"));
  });

  it("enforces the $80 minimum", async () => {
    const { presale, alice, start } = await loadFixture(deploy);
    await time.increaseTo(start);
    await expect(presale.connect(alice).buyWithETH(0n, { value: E("0.02") })).to.be.revertedWith("below minimum");
  });

  it("enforces $700 per round in rounds 1-5", async () => {
    const { presale, alice, start } = await loadFixture(deploy);
    await time.increaseTo(start);
    await expect(presale.connect(alice).buyWithToken(await presale.usdc(), U(701), 0n)).to.be.revertedWith("round limit");
    await presale.connect(alice).buyWithToken(await presale.usdc(), U(700), 0n);
    await expect(presale.connect(alice).buyWithToken(await presale.usdc(), U(80), 0n)).to.be.revertedWith("round limit");
  });

  it("moves to the next round after 12 days at a higher price", async () => {
    const { presale, alice, start } = await loadFixture(deploy);
    await time.increaseTo(start);
    await presale.connect(alice).buyWithToken(await presale.usdc(), U(700), 0n); // 87,500 ODX
    await time.increase(12 * DAY + 1);
    expect((await presale.saleState())[0]).to.equal(1n);
    await presale.connect(alice).buyWithToken(await presale.usdc(), U(100), 0n); // ~8,421 ODX at $0.011875
    const p = await presale.purchased(alice.address);
    expect(p).to.be.gt(E("95900"));
    expect(p).to.be.lt(E("95930"));
  });

  it("enforces the $2,000 wallet limit", async () => {
    const { presale, alice, start } = await loadFixture(deploy);
    const usdc = await presale.usdc();
    await time.increaseTo(start);
    await presale.connect(alice).buyWithToken(usdc, U(700), 0n);
    await time.increase(12 * DAY + 1);
    await presale.connect(alice).buyWithToken(usdc, U(700), 0n);
    await time.increase(12 * DAY + 1);
    await presale.connect(alice).buyWithToken(usdc, U(600), 0n); // total $2,000
    await time.increase(12 * DAY + 1);
    await expect(presale.connect(alice).buyWithToken(usdc, U(80), 0n)).to.be.revertedWith("wallet limit");
  });

  it("burns unsold tokens and releases 40% / 70% / 100%", async () => {
    const { token, presale, alice, start } = await loadFixture(deploy);
    await time.increaseTo(start);
    await presale.connect(alice).buyWithToken(await presale.usdc(), U(700), 0n); // 87,500 ODX
    await time.increaseTo(start + 17 * 12 * DAY + 5);
    await presale.connect(alice).claim();
    expect(await token.balanceOf(alice.address)).to.equal(E("35000"));
    expect(await token.totalSupply()).to.equal(E("1500000000") - E("300000000") + E("87500"));
    await time.increase(30 * DAY);
    await presale.connect(alice).claim();
    expect(await token.balanceOf(alice.address)).to.equal(E("61250"));
    await time.increase(60 * DAY);
    await presale.connect(alice).claim();
    expect(await token.balanceOf(alice.address)).to.equal(E("87500"));
  });

  it("forwards 100% of an ETH payment to the treasury at once and holds nothing", async () => {
    const { presale, alice, treasury, start } = await loadFixture(deploy);
    await time.increaseTo(start);
    const presaleAddr = await presale.getAddress();
    await expect(presale.connect(alice).buyWithETH(0n, { value: E("0.034") })).to.changeEtherBalances(
      [treasury, presaleAddr],
      [E("0.034"), 0n]
    );
    expect(await ethers.provider.getBalance(presaleAddr)).to.equal(0n);
    expect(await presale.purchased(alice.address)).to.equal(E("12750"));
  });

  it("forwards 100% of a USDC payment to the treasury at once and holds nothing", async () => {
    const { presale, usdc, alice, treasury, start } = await loadFixture(deploy);
    await time.increaseTo(start);
    await presale.connect(alice).buyWithToken(await usdc.getAddress(), U(700), 0n);
    expect(await usdc.balanceOf(treasury.address)).to.equal(U(700));
    expect(await usdc.balanceOf(await presale.getAddress())).to.equal(0n);
    expect(await usdc.balanceOf(alice.address)).to.equal(U(10000) - U(700));
  });

  it("rejects the whole ETH purchase if the treasury cannot receive ETH", async () => {
    const { token, usdc, usdt, ethFeed, usdcFeed, usdtFeed, alice } = await loadFixture(deploy);
    // a contract with no receive function (the mock USDC) acts as a treasury that refuses ETH
    const start2 = (await time.latest()) + 1000;
    const bad = await (await ethers.getContractFactory("OdysseyPresale")).deploy({
      token: await token.getAddress(),
      treasury: await usdc.getAddress(),
      startTime: start2,
      usdc: await usdc.getAddress(),
      usdt: await usdt.getAddress(),
      ethUsdFeed: await ethFeed.getAddress(),
      usdcUsdFeed: await usdcFeed.getAddress(),
      usdtUsdFeed: await usdtFeed.getAddress(),
    });
    await token.transfer(await bad.getAddress(), E("300000000"));
    await time.increaseTo(start2);
    await expect(bad.connect(alice).buyWithETH(0n, { value: E("0.034") })).to.be.revertedWith("treasury transfer failed");
    expect(await bad.purchased(alice.address)).to.equal(0n);
    expect(await bad.totalSold()).to.equal(0n);
  });
});
