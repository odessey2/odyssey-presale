const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

const E = ethers.parseEther;
const U = (n) => BigInt(n) * 10n ** 6n;
const DAY = 86400;

async function deploy() {
  const signers = await ethers.getSigners();
  const [deployer, treasury, ...rest] = signers;
  const buyers = rest.slice(0, 6);
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
  for (const b of buyers) {
    await usdc.mint(b.address, U(10000));
    await usdc.connect(b).approve(presaleAddr, ethers.MaxUint256);
  }
  return { deployer, treasury, buyers, token, presale, presaleAddr, usdc, start };
}

describe("OdysseyPresale audit fixes", () => {
  it("slippage (USDC): reverts when the round changed and fewer tokens would be credited", async () => {
    const { presale, usdc, buyers, start } = await loadFixture(deploy);
    const a = buyers[0];
    const usdcAddr = await usdc.getAddress();
    await time.increaseTo(start + 12 * DAY + 1); // round 2 now, $0.011875
    // the buyer expected the round 1 price: $100 -> 12,500 ODX
    await expect(presale.connect(a).buyWithToken(usdcAddr, U(100), E("12400"))).to.be.revertedWith("slippage");
    expect(await presale.purchased(a.address)).to.equal(0n);
    // with a minimum that fits the round 2 price it works
    await presale.connect(a).buyWithToken(usdcAddr, U(100), E("8400"));
    const got = await presale.purchased(a.address);
    expect(got).to.be.gt(E("8421"));
    expect(got).to.be.lt(E("8422"));
  });

  it("slippage (ETH): reverts when fewer tokens would be credited, and refunds nothing because nothing happens", async () => {
    const { presale, buyers, start } = await loadFixture(deploy);
    const a = buyers[1];
    await time.increaseTo(start + 12 * DAY + 1); // round 2
    await expect(presale.connect(a).buyWithETH(E("12000"), { value: E("0.034") })).to.be.revertedWith("slippage");
    expect(await presale.totalSold()).to.equal(0n);
    await presale.connect(a).buyWithETH(E("8500"), { value: E("0.034") }); // $102 at $0.011875 = about 8,589 ODX
    const got = await presale.purchased(a.address);
    expect(got).to.be.gt(E("8589"));
    expect(got).to.be.lt(E("8590"));
  });

  it("a minimum equal to the exact result passes, and 0 means no protection", async () => {
    const { presale, usdc, buyers, start } = await loadFixture(deploy);
    const usdcAddr = await usdc.getAddress();
    await time.increaseTo(start);
    await presale.connect(buyers[2]).buyWithToken(usdcAddr, U(80), E("10000")); // exactly 10,000 ODX at $0.008
    expect(await presale.purchased(buyers[2].address)).to.equal(E("10000"));
    await expect(presale.connect(buyers[3]).buyWithToken(usdcAddr, U(80), E("10001"))).to.be.revertedWith("slippage");
    await presale.connect(buyers[3]).buyWithToken(usdcAddr, U(80), 0n);
    expect(await presale.purchased(buyers[3].address)).to.equal(E("10000"));
  });

  it("finalize burns the unsold tokens and also tokens sent by mistake", async () => {
    const { token, presale, presaleAddr, usdc, buyers, start } = await loadFixture(deploy);
    const [deployer] = await ethers.getSigners();
    const a = buyers[0];
    await time.increaseTo(start);
    await presale.connect(a).buyWithToken(await usdc.getAddress(), U(700), 0n); // 87,500 ODX
    await token.connect(deployer).transfer(presaleAddr, E("1000")); // sent by mistake
    await time.increaseTo(start + 17 * 12 * DAY + 5);
    await presale.connect(a).claim(); // claim calls finalize first
    // everything above what buyers bought was burned: (300,000,000 - 87,500) unsold + 1,000 extra
    const burned = E("300000000") - E("87500") + E("1000");
    expect(await token.totalSupply()).to.equal(E("1500000000") - burned);
    // what is left in the presale is exactly what buyers still can claim: 87,500 - 35,000
    expect(await token.balanceOf(presaleAddr)).to.equal(E("87500") - E("35000"));
  });

  it("invariants after many mixed purchases", async () => {
    const { token, presale, presaleAddr, usdc, treasury, buyers, start } = await loadFixture(deploy);
    await time.increaseTo(start);
    const usdcAddr = await usdc.getAddress();
    const t0Eth = await ethers.provider.getBalance(treasury.address);
    let usdcPaid = 0n;
    let ethPaid = 0n;
    for (let i = 0; i < buyers.length; i++) {
      const b = buyers[i];
      const usdcAmount = U(80 + i * 37);
      await presale.connect(b).buyWithToken(usdcAddr, usdcAmount, 0n);
      usdcPaid += usdcAmount;
      const ethAmount = E("0.03") + BigInt(i) * 10n ** 15n; // about $90 to $105
      await presale.connect(b).buyWithETH(0n, { value: ethAmount });
      ethPaid += ethAmount;
    }
    let sum = 0n;
    for (const b of buyers) sum += await presale.purchased(b.address);
    expect(sum).to.equal(await presale.totalSold());
    expect(await presale.totalSold()).to.be.lte(E("300000000"));
    // the presale never holds money, and the treasury got exactly what was paid
    expect(await ethers.provider.getBalance(presaleAddr)).to.equal(0n);
    expect(await usdc.balanceOf(presaleAddr)).to.equal(0n);
    expect(await usdc.balanceOf(treasury.address)).to.equal(usdcPaid);
    expect((await ethers.provider.getBalance(treasury.address)) - t0Eth).to.equal(ethPaid);
    // the presale still holds all 300M ODX during the sale
    expect(await token.balanceOf(presaleAddr)).to.equal(E("300000000"));
    // nobody went over a limit
    for (const b of buyers) {
      expect(await presale.spentUsd(b.address)).to.be.lte(E("2000"));
    }
  });
});