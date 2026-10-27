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
  return { deployer, token, presale, usdc, usdt, treasury, alice, start };
}

// ---- helpers that put the LOCAL test chain into "last round almost sold out" state.
// Selling 300M tokens with $2,000 wallet caps would need thousands of wallets, so we write the
// presale's storage directly (this only changes the temporary Hardhat test chain, never a real contract).
const setSlot = (addr, slot, value) =>
  network.provider.send("hardhat_setStorageAt", [
    addr,
    ethers.toQuantity(slot),
    ethers.zeroPadValue(ethers.toBeHex(value), 32),
  ]);

async function findRoundStartSlot(addr, start) {
  // roundStart is set to startTime in the constructor, so the slot holding that value is roundStart.
  for (let i = 0; i < 10; i++) {
    const v = await ethers.provider.getStorage(addr, i);
    if (BigInt(v) === BigInt(start)) return i;
  }
  throw new Error("roundStart storage slot not found");
}

async function forgeLastRound(presale, start, remaining) {
  const addr = await presale.getAddress();
  const s = await findRoundStartSlot(addr, start);
  const cap = await presale.roundCap(16);
  const total = await presale.TOTAL_FOR_SALE();
  const now = await time.latest();
  // layout: round = s-1, roundStart = s, endTime = s+1, totalSold = s+2, finalized = s+3, roundSold mapping = s+4
  await setSlot(addr, s - 1, 16n);
  await setSlot(addr, s, BigInt(now));
  await setSlot(addr, s + 2, total - remaining);
  const key = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(["uint256", "uint256"], [16n, BigInt(s + 4)])
  );
  await setSlot(addr, key, cap - remaining);
  // sanity checks: if the storage layout guess is wrong these fail with a clear message
  expect(await presale.round()).to.equal(16n);
  expect(await presale.totalSold()).to.equal(total - remaining);
  expect(await presale.roundSold(16)).to.equal(cap - remaining);
  const state = await presale.saleState();
  expect(state[0]).to.equal(16n);
  expect(state[2]).to.equal(remaining);
}

describe("OdysseyPresale edge cases 2", () => {
  it("last round sells out with a partial fill: refund, early end, 40% claim, no burn", async () => {
    const { token, presale, treasury, alice, start } = await loadFixture(deploy);
    await time.increaseTo(start);
    await forgeLastRound(presale, start, E("1000")); // only 1,000 ODX left in round 17
    const addr = await presale.getAddress();

    const before = await ethers.provider.getBalance(treasury.address);
    await presale.connect(alice).buyWithETH(0n, { value: E("0.034") }); // $102, but only $70 worth is left
    const paid = (await ethers.provider.getBalance(treasury.address)) - before;

    // the buyer gets the remaining 1,000 ODX and pays exactly 70/102 of the ETH (rounded up); the rest is returned
    expect(await presale.purchased(alice.address)).to.equal(E("1000"));
    expect(paid).to.equal((E("0.034") * 70n + 101n) / 102n);
    // the presale contract holds nothing: the used part went to the treasury, the rest back to the buyer
    expect(await ethers.provider.getBalance(addr)).to.equal(0n);
    // only the money actually used counts against the wallet limit
    expect(await presale.spentUsd(alice.address)).to.equal(E("70"));

    // the presale ended right away
    const state = await presale.saleState();
    expect(state[0]).to.equal(17n);
    expect(state[4]).to.equal(true);
    expect(await presale.presaleEnd()).to.be.gt(0n);
    expect(await presale.unlockedPercent()).to.equal(40n);
    await expect(presale.connect(alice).buyWithETH(0n, { value: E("0.034") })).to.be.revertedWith("presale ended");

    // claim works immediately (40%), nothing is burned because everything was sold
    await presale.connect(alice).claim();
    expect(await token.balanceOf(alice.address)).to.equal(E("400"));
    expect(await presale.finalized()).to.equal(true);
    expect(await token.totalSupply()).to.equal(E("1500000000"));
    expect(await ethers.provider.getBalance(addr)).to.equal(0n);
  });

  it("last round sells out with a partial fill in USDC: only the used amount moves", async () => {
    const { presale, usdc, treasury, alice, start } = await loadFixture(deploy);
    await time.increaseTo(start);
    await forgeLastRound(presale, start, E("1000")); // only 1,000 ODX left = $70
    const usdcAddr = await usdc.getAddress();

    await presale.connect(alice).buyWithToken(usdcAddr, U(100), 0n); // wants $100, only $70 worth is left
    expect(await presale.purchased(alice.address)).to.equal(E("1000"));
    expect(await usdc.balanceOf(alice.address)).to.equal(U(10000) - U(70));
    expect(await usdc.balanceOf(treasury.address)).to.equal(U(70));
    expect(await usdc.balanceOf(await presale.getAddress())).to.equal(0n);
    expect(await presale.spentUsd(alice.address)).to.equal(E("70"));
    expect((await presale.saleState())[4]).to.equal(true);
  });

  it("last round sells out exactly: no refund, presale ends at once", async () => {
    const { presale, usdc, treasury, alice, start } = await loadFixture(deploy);
    await time.increaseTo(start);
    await forgeLastRound(presale, start, E("1200")); // 1,200 ODX x $0.07 = $84 exactly
    const usdcAddr = await usdc.getAddress();

    const balBefore = await usdc.balanceOf(alice.address);
    await presale.connect(alice).buyWithToken(usdcAddr, U(84), 0n);
    expect(balBefore - (await usdc.balanceOf(alice.address))).to.equal(U(84));
    expect(await usdc.balanceOf(treasury.address)).to.equal(U(84));
    expect(await presale.purchased(alice.address)).to.equal(E("1200"));
    expect((await presale.saleState())[4]).to.equal(true);
    await expect(presale.connect(alice).buyWithToken(usdcAddr, U(80), 0n)).to.be.revertedWith("presale ended");
  });

  it("rounding never credits more tokens than paid, in all 17 rounds", async function () {
    this.timeout(120000);
    const { presale, usdc, alice, start } = await loadFixture(deploy);
    const usdcAddr = await usdc.getAddress();
    for (let i = 0; i < 17; i++) {
      await time.increaseTo(start + i * 12 * DAY + 1);
      expect((await presale.saleState())[0]).to.equal(BigInt(i));
      const amount = 80_000_000n + BigInt(i) * 1_234_567n + 7n; // odd micro-USDC amounts
      const before = await presale.purchased(alice.address);
      await presale.connect(alice).buyWithToken(usdcAddr, amount, 0n);
      const got = (await presale.purchased(alice.address)) - before;
      const price = await presale.priceOf(i);
      const paid18 = amount * 10n ** 12n * 10n ** 18n;
      expect(got * price).to.be.lte(paid18); // never more than paid
      expect((got + 1n) * price).to.be.gt(paid18); // never more than 1 wei of ODX lost
    }
  });

  it("wallet limit boundary: exactly $2,000 passes, one micro-dollar more fails", async () => {
    const { presale, usdc, alice, start } = await loadFixture(deploy);
    const usdcAddr = await usdc.getAddress();
    await time.increaseTo(start + 5 * 12 * DAY + 1); // round 6: no per-round limit any more
    expect((await presale.saleState())[0]).to.equal(5n);
    await expect(presale.connect(alice).buyWithToken(usdcAddr, U(2000) + 1n, 0n)).to.be.revertedWith("wallet limit");
    await presale.connect(alice).buyWithToken(usdcAddr, U(1500), 0n);
    expect(await presale.remainingAllowanceUsd(alice.address)).to.equal(E("500"));
    await expect(presale.connect(alice).buyWithToken(usdcAddr, U(500) + 1n, 0n)).to.be.revertedWith("wallet limit");
    await presale.connect(alice).buyWithToken(usdcAddr, U(500), 0n);
    expect(await presale.remainingAllowanceUsd(alice.address)).to.equal(0n);
    expect(await presale.spentUsd(alice.address)).to.equal(E("2000"));
  });
});
