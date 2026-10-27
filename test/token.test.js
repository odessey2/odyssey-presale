const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

const E = ethers.parseEther;

async function deploy() {
  const [deployer, alice, bob] = await ethers.getSigners();
  const token = await (await ethers.getContractFactory("OdysseyToken")).deploy(deployer.address);
  await token.transfer(alice.address, E("1000"));
  return { token, deployer, alice, bob };
}

describe("OdysseyToken", () => {
  it("has a fixed supply minted once, and 18 decimals", async () => {
    const { token, deployer } = await loadFixture(deploy);
    expect(await token.totalSupply()).to.equal(E("1500000000"));
    expect(await token.MAX_SUPPLY()).to.equal(E("1500000000"));
    expect(await token.decimals()).to.equal(18n);
    expect((await token.balanceOf(deployer.address)) + E("1000")).to.equal(E("1500000000"));
  });

  it("a holder can burn their own tokens, and the supply goes down", async () => {
    const { token, alice } = await loadFixture(deploy);
    await token.connect(alice).burn(E("100"));
    expect(await token.balanceOf(alice.address)).to.equal(E("900"));
    expect(await token.totalSupply()).to.equal(E("1500000000") - E("100"));
  });

  it("burnFrom works only with an allowance", async () => {
    const { token, alice, bob } = await loadFixture(deploy);
    await expect(token.connect(bob).burnFrom(alice.address, E("10"))).to.be.reverted;
    await token.connect(alice).approve(bob.address, E("10"));
    await token.connect(bob).burnFrom(alice.address, E("10"));
    expect(await token.balanceOf(alice.address)).to.equal(E("990"));
  });

  it("permit gives an allowance by signature, once, and not after the deadline", async () => {
    const { token, alice, bob } = await loadFixture(deploy);
    const domain = {
      name: "Odyssey DEX",
      version: "1",
      chainId: (await ethers.provider.getNetwork()).chainId,
      verifyingContract: await token.getAddress(),
    };
    const types = {
      Permit: [
        { name: "owner", type: "address" },
        { name: "spender", type: "address" },
        { name: "value", type: "uint256" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" },
      ],
    };
    const sign = async (deadline) => {
      const nonce = await token.nonces(alice.address);
      const value = { owner: alice.address, spender: bob.address, value: E("100"), nonce, deadline };
      return ethers.Signature.from(await alice.signTypedData(domain, types, value));
    };
    const deadline = (await time.latest()) + 3600;
    const sig = await sign(deadline);
    await token.permit(alice.address, bob.address, E("100"), deadline, sig.v, sig.r, sig.s);
    expect(await token.allowance(alice.address, bob.address)).to.equal(E("100"));
    // the same signature cannot be used again
    await expect(token.permit(alice.address, bob.address, E("100"), deadline, sig.v, sig.r, sig.s)).to.be.reverted;
    // an expired signature is rejected
    const old = (await time.latest()) - 10;
    const sig2 = await sign(old);
    await expect(token.permit(alice.address, bob.address, E("100"), old, sig2.v, sig2.r, sig2.s)).to.be.reverted;
  });

  it("voting power starts after delegation and follows transfers", async () => {
    const { token, alice, bob } = await loadFixture(deploy);
    expect(await token.getVotes(alice.address)).to.equal(0n); // not delegated yet
    await token.connect(alice).delegate(alice.address);
    expect(await token.getVotes(alice.address)).to.equal(E("1000"));
    await token.connect(bob).delegate(bob.address);
    await token.connect(alice).transfer(bob.address, E("300"));
    expect(await token.getVotes(alice.address)).to.equal(E("700"));
    expect(await token.getVotes(bob.address)).to.equal(E("300"));
  });

  it("a burn lowers the voting power too", async () => {
    const { token, alice } = await loadFixture(deploy);
    await token.connect(alice).delegate(alice.address);
    await token.connect(alice).burn(E("200"));
    expect(await token.getVotes(alice.address)).to.equal(E("800"));
  });
});