const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");

const S = { Created: 0, Funded: 1, Delivered: 2, Released: 3, Refunded: 4 };
const PRICE = ethers.parseEther("1");
const SPEC = ethers.id("Oil: 100 tonnes, certificate v1");
const REASON = ethers.id("Specification mismatch");

async function fixture() {
  const [buyer, supplier, outsider] = await ethers.getSigners();
  const escrow = await ethers.deployContract("OilGasEscrow", [buyer.address, supplier.address]);
  const deadline = (await time.latest()) + 3600;
  return { escrow, buyer, supplier, outsider, deadline };
}
async function createdFixture() {
  const f = await fixture();
  await f.escrow.createBatch(1, 100, PRICE, SPEC, f.deadline);
  return f;
}
async function fundedFixture() {
  const f = await createdFixture();
  await f.escrow.fundBatch(1, { value: PRICE });
  return f;
}
async function deliveredFixture() {
  const f = await fundedFixture();
  await f.escrow.connect(f.supplier).markDelivered(1);
  return f;
}
async function actorFixture(actorIsBuyer) {
  const [buyer, supplier] = await ethers.getSigners();
  const actor = await ethers.deployContract("AdversarialParticipant");
  const actorAddress = await actor.getAddress();
  const escrow = await ethers.deployContract("OilGasEscrow", [
    actorIsBuyer ? actorAddress : buyer.address,
    actorIsBuyer ? supplier.address : actorAddress,
  ]);
  const target = await escrow.getAddress();
  await actor.configure(target, "0x", false);
  const deadline = (await time.latest()) + 3600;
  async function buyerCall(name, args, value = 0n) {
    if (actorIsBuyer) return actor.invoke(escrow.interface.encodeFunctionData(name, args), { value });
    return escrow.connect(buyer)[name](...args, { value });
  }
  async function supplierCall(id) {
    if (actorIsBuyer) return escrow.connect(supplier).markDelivered(id);
    return actor.invoke(escrow.interface.encodeFunctionData("markDelivered", [id]));
  }
  await buyerCall("createBatch", [1, 100, PRICE, SPEC, deadline]);
  await buyerCall("fundBatch", [1], PRICE);
  return { escrow, actor, target, deadline, buyerCall, supplierCall };
}

describe("OilGasEscrow", function () {
  describe("Participants and access control", function () {
    it("sets distinct fixed roles without granting a role administrator", async function () {
      const { escrow, buyer, supplier, outsider } = await loadFixture(fixture);
      expect(await escrow.buyer()).to.equal(buyer.address);
      expect(await escrow.supplier()).to.equal(supplier.address);
      expect(await escrow.hasRole(await escrow.BUYER_ROLE(), buyer.address)).to.equal(true);
      expect(await escrow.hasRole(await escrow.SUPPLIER_ROLE(), supplier.address)).to.equal(true);
      for (const user of [buyer, supplier, outsider]) {
        expect(await escrow.hasRole(ethers.ZeroHash, user.address)).to.equal(false);
      }
      expect(await escrow.totalEscrowed()).to.equal(0);
    });
    for (const kind of ["zero buyer", "zero supplier", "same participants"]) {
      it(`rejects ${kind}`, async function () {
        const { buyer, supplier } = await loadFixture(fixture);
        const args = kind === "zero buyer" ? [ethers.ZeroAddress, supplier.address]
          : kind === "zero supplier" ? [buyer.address, ethers.ZeroAddress] : [buyer.address, buyer.address];
        const factory = await ethers.getContractFactory("OilGasEscrow");
        await expect(factory.deploy(...args)).to.be.revertedWithCustomError(factory, "InvalidParticipants");
      });
    }
    for (const action of ["createBatch", "fundBatch", "releasePayment", "refund", "rejectBatch"]) {
      for (const user of ["supplier", "outsider"]) {
        it(`denies ${action} to ${user}`, async function () {
          const f = await loadFixture(deliveredFixture);
          const args = action === "createBatch" ? [2, 100, PRICE, SPEC, f.deadline]
            : action === "rejectBatch" ? [1, REASON] : [1];
          const overrides = action === "fundBatch" ? { value: PRICE } : {};
          await expect(f.escrow.connect(f[user])[action](...args, overrides))
            .to.be.revertedWithCustomError(f.escrow, "AccessControlUnauthorizedAccount")
            .withArgs(f[user].address, await f.escrow.BUYER_ROLE());
        });
      }
    }
    for (const user of ["buyer", "outsider"]) {
      it(`denies markDelivered to ${user}`, async function () {
        const f = await loadFixture(fundedFixture);
        await expect(f.escrow.connect(f[user]).markDelivered(1))
          .to.be.revertedWithCustomError(f.escrow, "AccessControlUnauthorizedAccount")
          .withArgs(f[user].address, await f.escrow.SUPPLIER_ROLE());
      });
    }
    it("prevents granting, revoking or renouncing roles", async function () {
      const { escrow, buyer, outsider } = await loadFixture(fixture);
      const role = await escrow.BUYER_ROLE();
      await expect(escrow.grantRole(role, outsider.address)).to.be.revertedWithCustomError(escrow, "AccessControlUnauthorizedAccount");
      await expect(escrow.revokeRole(role, buyer.address)).to.be.revertedWithCustomError(escrow, "AccessControlUnauthorizedAccount");
      await expect(escrow.renounceRole(role, buyer.address)).to.be.revertedWithCustomError(escrow, "RolesImmutable");
      expect(await escrow.hasRole(role, buyer.address)).to.equal(true);
    });
  });

  describe("Creation and metadata", function () {
    it("stores every field and emits BatchCreated", async function () {
      const { escrow, deadline } = await loadFixture(fixture);
      await expect(escrow.createBatch(1, 100, PRICE, SPEC, deadline))
        .to.emit(escrow, "BatchCreated").withArgs(1, 100, PRICE, SPEC, deadline);
      const batch = await escrow.getBatch(1);
      expect([...batch]).to.deep.equal([1n, 100n, PRICE, SPEC, 0n, BigInt(deadline)]);
      expect(await escrow.batchExists(1)).to.equal(true);
    });
    it("accepts id zero without confusing it with an absent batch", async function () {
      const { escrow, deadline } = await loadFixture(fixture);
      await escrow.createBatch(0, 1, 1, SPEC, deadline);
      expect((await escrow.getBatch(0)).id).to.equal(0);
      expect(await escrow.batchExists(999)).to.equal(false);
      await expect(escrow.getBatch(999)).to.be.revertedWithCustomError(escrow, "BatchNotFound").withArgs(999);
    });
    it("rejects duplicate ids without overwriting metadata", async function () {
      const { escrow, deadline } = await loadFixture(createdFixture);
      await expect(escrow.createBatch(1, 200, PRICE * 2n, REASON, deadline + 100))
        .to.be.revertedWithCustomError(escrow, "BatchAlreadyExists").withArgs(1);
      expect((await escrow.getBatch(1)).volume).to.equal(100);
    });
    for (const invalid of ["volume", "price", "hash", "past", "exact timestamp"]) {
      it(`rejects invalid ${invalid}`, async function () {
        const { escrow, deadline } = await loadFixture(fixture);
        const next = (await time.latest()) + 10;
        await time.setNextBlockTimestamp(next);
        await expect(escrow.createBatch(1, invalid === "volume" ? 0 : 100,
          invalid === "price" ? 0 : PRICE, invalid === "hash" ? ethers.ZeroHash : SPEC,
          invalid === "past" ? next - 1 : invalid === "exact timestamp" ? next : deadline))
          .to.be.revertedWithCustomError(escrow, "InvalidBatchParameters");
        expect(await escrow.batchExists(1)).to.equal(false);
      });
    }
    for (const action of ["fundBatch", "markDelivered", "releasePayment", "refund", "rejectBatch"]) {
      it(`rejects an unknown id in ${action}`, async function () {
        const { escrow, supplier } = await loadFixture(fixture);
        const connected = action === "markDelivered" ? escrow.connect(supplier) : escrow;
        const args = action === "rejectBatch" ? [99, REASON] : [99];
        await expect(connected[action](...args)).to.be.revertedWithCustomError(escrow, "BatchNotFound").withArgs(99);
      });
    }
  });

  describe("Payments and deadline boundaries", function () {
    it("funds only the exact price and emits Funded", async function () {
      const { escrow, buyer } = await loadFixture(createdFixture);
      await expect(escrow.fundBatch(1, { value: PRICE }))
        .to.emit(escrow, "Funded").withArgs(1, buyer.address, PRICE);
      expect((await escrow.getBatch(1)).status).to.equal(S.Funded);
      expect(await escrow.totalEscrowed()).to.equal(PRICE);
      expect(await ethers.provider.getBalance(await escrow.getAddress())).to.equal(PRICE);
    });
    for (const amount of [0n, PRICE - 1n, PRICE + 1n]) {
      it(`rejects payment ${amount} wei without changing balance or status`, async function () {
        const { escrow } = await loadFixture(createdFixture);
        await expect(escrow.fundBatch(1, { value: amount }))
          .to.be.revertedWithCustomError(escrow, "IncorrectPayment").withArgs(amount, PRICE);
        expect((await escrow.getBatch(1)).status).to.equal(S.Created);
        expect(await escrow.totalEscrowed()).to.equal(0);
        expect(await ethers.provider.getBalance(await escrow.getAddress())).to.equal(0);
      });
    }
    it("allows funding one second before deadline", async function () {
      const { escrow, deadline } = await loadFixture(createdFixture);
      await time.setNextBlockTimestamp(deadline - 1);
      await escrow.fundBatch(1, { value: PRICE });
      expect(await escrow.totalEscrowed()).to.equal(PRICE);
    });
    for (const offset of [0, 1]) {
      it(`rejects funding at deadline + ${offset}`, async function () {
        const { escrow, deadline } = await loadFixture(createdFixture);
        await time.setNextBlockTimestamp(deadline + offset);
        await expect(escrow.fundBatch(1, { value: PRICE })).to.be.revertedWithCustomError(escrow, "DeadlinePassed");
      });
      it(`rejects delivery at deadline + ${offset}`, async function () {
        const { escrow, supplier, deadline } = await loadFixture(fundedFixture);
        await time.setNextBlockTimestamp(deadline + offset);
        await expect(escrow.connect(supplier).markDelivered(1)).to.be.revertedWithCustomError(escrow, "DeadlinePassed");
        expect((await escrow.getBatch(1)).status).to.equal(S.Funded);
      });
      it(`allows timeout refund at deadline + ${offset}`, async function () {
        const { escrow, buyer, deadline } = await loadFixture(fundedFixture);
        await time.setNextBlockTimestamp(deadline + offset);
        await expect(escrow.refund(1)).to.changeEtherBalances([escrow, buyer], [-PRICE, PRICE]);
        expect((await escrow.getBatch(1)).status).to.equal(S.Refunded);
        expect(await escrow.totalEscrowed()).to.equal(0);
      });
    }
    it("allows delivery one second before deadline and emits Delivered", async function () {
      const { escrow, supplier, deadline } = await loadFixture(fundedFixture);
      await time.setNextBlockTimestamp(deadline - 1);
      await expect(escrow.connect(supplier).markDelivered(1)).to.emit(escrow, "Delivered").withArgs(1, supplier.address);
    });
    it("rejects refund one second before deadline", async function () {
      const { escrow, deadline } = await loadFixture(fundedFixture);
      await time.setNextBlockTimestamp(deadline - 1);
      await expect(escrow.refund(1)).to.be.revertedWithCustomError(escrow, "DeadlineNotReached");
      expect(await escrow.totalEscrowed()).to.equal(PRICE);
    });
    it("returns ETH and emits Refunded on timeout", async function () {
      const { escrow, buyer, deadline } = await loadFixture(fundedFixture);
      await time.setNextBlockTimestamp(deadline);
      await expect(escrow.refund(1)).to.emit(escrow, "Refunded").withArgs(1, buyer.address, PRICE);
    });
  });

  describe("Acceptance and rejection", function () {
    it("completes create -> fund -> deliver -> release with an exact supplier payment", async function () {
      const { escrow, supplier } = await loadFixture(deliveredFixture);
      await expect(escrow.releasePayment(1)).to.changeEtherBalances([escrow, supplier], [-PRICE, PRICE]);
      expect((await escrow.getBatch(1)).status).to.equal(S.Released);
      expect(await escrow.totalEscrowed()).to.equal(0);
    });
    it("emits PaymentReleased", async function () {
      const { escrow, supplier } = await loadFixture(deliveredFixture);
      await expect(escrow.releasePayment(1)).to.emit(escrow, "PaymentReleased").withArgs(1, supplier.address, PRICE);
    });
    it("keeps timely delivered batches payable after deadline", async function () {
      const { escrow, deadline } = await loadFixture(deliveredFixture);
      await time.setNextBlockTimestamp(deadline + 100);
      await escrow.releasePayment(1);
      expect((await escrow.getBatch(1)).status).to.equal(S.Released);
    });
    it("does not timeout-refund a timely delivered batch", async function () {
      const { escrow, deadline } = await loadFixture(deliveredFixture);
      await time.setNextBlockTimestamp(deadline + 100);
      await expect(escrow.refund(1)).to.be.revertedWithCustomError(escrow, "InvalidStatus").withArgs(1, S.Delivered, S.Funded);
    });
    it("rejects a delivered batch and immediately refunds its exact price", async function () {
      const { escrow, buyer } = await loadFixture(deliveredFixture);
      await expect(escrow.rejectBatch(1, REASON)).to.changeEtherBalances([escrow, buyer], [-PRICE, PRICE]);
      expect((await escrow.getBatch(1)).status).to.equal(S.Refunded);
      expect(await escrow.totalEscrowed()).to.equal(0);
    });
    it("emits both rejection evidence and refund events", async function () {
      const { escrow, buyer } = await loadFixture(deliveredFixture);
      await expect(escrow.rejectBatch(1, REASON))
        .to.emit(escrow, "BatchRejected").withArgs(1, REASON)
        .and.to.emit(escrow, "Refunded").withArgs(1, buyer.address, PRICE);
    });
    it("requires a nonzero rejection reason hash", async function () {
      const { escrow } = await loadFixture(deliveredFixture);
      await expect(escrow.rejectBatch(1, ethers.ZeroHash)).to.be.revertedWithCustomError(escrow, "InvalidBatchParameters");
      expect((await escrow.getBatch(1)).status).to.equal(S.Delivered);
      expect(await escrow.totalEscrowed()).to.equal(PRICE);
    });
  });

  describe("All invalid state transitions", function () {
    const expected = { fundBatch: S.Created, markDelivered: S.Funded, releasePayment: S.Delivered, refund: S.Funded, rejectBatch: S.Delivered };
    for (const [state, number] of Object.entries(S)) {
      for (const [action, needed] of Object.entries(expected)) {
        if (number === needed) continue;
        it(`blocks ${action} from ${state}`, async function () {
          const f = await loadFixture(createdFixture);
          if (number !== S.Created) await f.escrow.fundBatch(1, { value: PRICE });
          if ([S.Delivered, S.Released].includes(number)) await f.escrow.connect(f.supplier).markDelivered(1);
          if (number === S.Released) await f.escrow.releasePayment(1);
          if (number === S.Refunded) {
            await time.setNextBlockTimestamp(f.deadline);
            await f.escrow.refund(1);
          }
          const c = action === "markDelivered" ? f.escrow.connect(f.supplier) : f.escrow;
          const args = action === "rejectBatch" ? [1, REASON] : [1];
          await expect(c[action](...args, action === "fundBatch" ? { value: PRICE } : {}))
            .to.be.revertedWithCustomError(f.escrow, "InvalidStatus").withArgs(1, number, needed);
          expect((await f.escrow.getBatch(1)).status).to.equal(number);
        });
      }
    }
    it("does not reuse a terminal batch id", async function () {
      const { escrow, deadline } = await loadFixture(deliveredFixture);
      await escrow.releasePayment(1);
      await expect(escrow.createBatch(1, 100, PRICE, SPEC, deadline)).to.be.revertedWithCustomError(escrow, "BatchAlreadyExists");
    });
  });

  describe("Adversarial recipients and reentrancy", function () {
    it("rolls back release when the supplier rejects ETH and permits a retry", async function () {
      const f = await actorFixture(false);
      await f.supplierCall(1);
      await f.actor.configure(f.target, "0x", true);
      await expect(f.escrow.releasePayment(1)).to.be.revertedWithCustomError(f.escrow, "TransferFailed")
        .withArgs(await f.actor.getAddress(), PRICE);
      expect((await f.escrow.getBatch(1)).status).to.equal(S.Delivered);
      expect(await f.escrow.totalEscrowed()).to.equal(PRICE);
      expect(await ethers.provider.getBalance(f.target)).to.equal(PRICE);
      await f.actor.configure(f.target, "0x", false);
      await f.escrow.releasePayment(1);
      expect(await f.actor.receipts()).to.equal(1);
    });
    for (const action of ["refund", "rejectBatch"]) {
      it(`rolls back ${action} when buyer rejects ETH and permits a retry`, async function () {
        const f = await actorFixture(true);
        if (action === "rejectBatch") await f.supplierCall(1);
        await f.actor.configure(f.target, "0x", true);
        if (action === "refund") await time.setNextBlockTimestamp(f.deadline);
        const args = action === "rejectBatch" ? [1, REASON] : [1];
        await expect(f.buyerCall(action, args)).to.be.revertedWithCustomError(f.escrow, "TransferFailed");
        expect((await f.escrow.getBatch(1)).status).to.equal(action === "refund" ? S.Funded : S.Delivered);
        expect(await f.escrow.totalEscrowed()).to.equal(PRICE);
        expect(await ethers.provider.getBalance(f.target)).to.equal(PRICE);
        await f.actor.configure(f.target, "0x", false);
        await f.buyerCall(action, args);
        expect(await f.actor.receipts()).to.equal(1);
        expect(await f.escrow.totalEscrowed()).to.equal(0);
      });
      it(`blocks same-batch reentrancy during ${action}`, async function () {
        const f = await actorFixture(true);
        if (action === "rejectBatch") await f.supplierCall(1);
        const args = action === "rejectBatch" ? [1, REASON] : [1];
        await f.actor.configure(f.target, f.escrow.interface.encodeFunctionData(action, args), false);
        if (action === "refund") await time.setNextBlockTimestamp(f.deadline);
        await f.buyerCall(action, args);
        expect(await f.actor.callbackSucceeded()).to.equal(false);
        expect(await f.actor.callbackError()).to.equal(ethers.id("ReentrancyGuardReentrantCall()").slice(0, 10));
        expect(await f.actor.receipts()).to.equal(1);
        expect(await f.escrow.totalEscrowed()).to.equal(0);
      });
    }
    it("blocks cross-batch reentrancy without taking another batch's escrow", async function () {
      const f = await actorFixture(true);
      await f.buyerCall("createBatch", [2, 100, PRICE, SPEC, f.deadline]);
      await f.buyerCall("fundBatch", [2], PRICE);
      await f.actor.configure(f.target, f.escrow.interface.encodeFunctionData("refund", [2]), false);
      await time.setNextBlockTimestamp(f.deadline);
      await f.buyerCall("refund", [1]);
      expect(await f.actor.callbackError()).to.equal(ethers.id("ReentrancyGuardReentrantCall()").slice(0, 10));
      expect((await f.escrow.getBatch(2)).status).to.equal(S.Funded);
      expect(await f.escrow.totalEscrowed()).to.equal(PRICE);
      expect(await ethers.provider.getBalance(f.target)).to.equal(PRICE);
      await f.buyerCall("refund", [2]);
      expect(await f.actor.receipts()).to.equal(2);
    });
    it("blocks reentrant funding during a refund", async function () {
      const f = await actorFixture(true);
      await f.buyerCall("createBatch", [2, 100, PRICE, SPEC, f.deadline + 3600]);
      await f.actor.configure(f.target, f.escrow.interface.encodeFunctionData("fundBatch", [2]), false);
      await time.setNextBlockTimestamp(f.deadline);
      await f.buyerCall("refund", [1]);
      expect(await f.actor.callbackError()).to.equal(ethers.id("ReentrancyGuardReentrantCall()").slice(0, 10));
      expect((await f.escrow.getBatch(2)).status).to.equal(S.Created);
    });
    it("prevents the supplier from accepting its own delivery during a payment callback", async function () {
      const f = await actorFixture(false);
      await f.supplierCall(1);
      await f.actor.configure(f.target, f.escrow.interface.encodeFunctionData("releasePayment", [1]), false);
      await f.escrow.releasePayment(1);
      expect(await f.actor.callbackSucceeded()).to.equal(false);
      expect(await f.actor.callbackError()).to.equal(ethers.id("AccessControlUnauthorizedAccount(address,bytes32)").slice(0, 10));
      expect(await f.actor.receipts()).to.equal(1);
      expect(await f.escrow.totalEscrowed()).to.equal(0);
    });
    it("rejects direct ETH transfers outside fundBatch", async function () {
      const { escrow, buyer } = await loadFixture(fixture);
      await expect(buyer.sendTransaction({ to: await escrow.getAddress(), value: PRICE })).to.be.reverted;
      expect(await escrow.totalEscrowed()).to.equal(0);
    });
  });

  describe("Escrow accounting invariants", function () {
    it("does not treat forced ETH as escrow or distribute it with a batch payment", async function () {
      const { escrow, supplier } = await loadFixture(deliveredFixture);
      const target = await escrow.getAddress();
      await ethers.deployContract("ForceEther", [target], { value: 7n });
      expect(await escrow.totalEscrowed()).to.equal(PRICE);
      expect(await ethers.provider.getBalance(target)).to.equal(PRICE + 7n);
      await expect(escrow.releasePayment(1)).to.changeEtherBalances([escrow, supplier], [-PRICE, PRICE]);
      expect(await escrow.totalEscrowed()).to.equal(0);
      expect(await ethers.provider.getBalance(target)).to.equal(7n);
    });
    it("preserves metadata and isolates multiple batches with different prices", async function () {
      const { escrow, supplier, deadline } = await loadFixture(fixture);
      const ids = [0, 1, 2, 3];
      const metadata = new Map();
      for (const id of ids) {
        await escrow.createBatch(id, id + 1, PRICE * BigInt(id + 1), SPEC, deadline);
        metadata.set(id, await escrow.getBatch(id));
      }
      async function check() {
        let liability = 0n;
        for (const id of ids) {
          const b = await escrow.getBatch(id);
          const initial = metadata.get(id);
          for (const key of ["id", "volume", "priceWei", "specHash", "deadline"]) expect(b[key]).to.equal(initial[key]);
          if ([BigInt(S.Funded), BigInt(S.Delivered)].includes(b.status)) liability += b.priceWei;
        }
        expect(await escrow.totalEscrowed()).to.equal(liability);
        expect(await ethers.provider.getBalance(await escrow.getAddress())).to.equal(liability);
      }
      await check();
      for (const id of ids) {
        await escrow.fundBatch(id, { value: PRICE * BigInt(id + 1) });
        await check();
      }
      for (const id of [0, 1]) { await escrow.connect(supplier).markDelivered(id); await check(); }
      await escrow.releasePayment(0); await check();
      await escrow.rejectBatch(1, REASON); await check();
      await time.setNextBlockTimestamp(deadline);
      for (const id of [2, 3]) { await escrow.refund(id); await check(); }
      expect(await escrow.totalEscrowed()).to.equal(0);
    });
    it("checks the liability invariant after a seeded sequence of 32 independent batches", async function () {
      const { escrow, supplier, deadline } = await loadFixture(fixture);
      let seed = 20261011;
      let liability = 0n;
      const pending = [];
      for (let id = 0; id < 32; id++) {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        const price = BigInt(1 + seed % 1000000);
        await escrow.createBatch(id, id + 1, price, SPEC, deadline);
        await escrow.fundBatch(id, { value: price });
        liability += price;
        expect(await escrow.totalEscrowed()).to.equal(liability);
        expect(await ethers.provider.getBalance(await escrow.getAddress())).to.equal(liability);
        if (seed % 3 === 0) { pending.push([id, price]); continue; }
        await escrow.connect(supplier).markDelivered(id);
        if (seed % 3 === 1) await escrow.releasePayment(id);
        else await escrow.rejectBatch(id, REASON);
        liability -= price;
        expect(await escrow.totalEscrowed()).to.equal(liability);
        expect(await ethers.provider.getBalance(await escrow.getAddress())).to.equal(liability);
      }
      await time.setNextBlockTimestamp(deadline);
      for (const [id, price] of pending) {
        await escrow.refund(id); liability -= price;
        expect(await escrow.totalEscrowed()).to.equal(liability);
        expect(await ethers.provider.getBalance(await escrow.getAddress())).to.equal(liability);
      }
      expect(liability).to.equal(0);
    });
  });
});
