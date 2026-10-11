const { ethers, network } = require("hardhat");

async function main() {
  if (network.name !== "hardhat") throw new Error("Demo uses the ephemeral local Hardhat network only");
  const [buyer, supplier] = await ethers.getSigners();
  const escrow = await ethers.deployContract("OilGasEscrow", [buyer.address, supplier.address]);
  await escrow.waitForDeployment();
  const spec = ethers.id("Oil batch: 100 tonnes; quality certificate v1");
  const price = ethers.parseEther("1");
  const now = (await ethers.provider.getBlock("latest")).timestamp;
  const deadline = now + 3600;
  console.log("Contract:", await escrow.getAddress());
  for (const id of [1, 2, 3]) {
    await (await escrow.createBatch(id, 100, price, spec, deadline)).wait();
    await (await escrow.fundBatch(id, { value: price })).wait();
  }
  await (await escrow.connect(supplier).markDelivered(1)).wait();
  await (await escrow.releasePayment(1)).wait();
  console.log("Batch 1: Created -> Funded -> Delivered -> Released");
  await (await escrow.connect(supplier).markDelivered(3)).wait();
  await (await escrow.rejectBatch(3, ethers.id("Quality certificate mismatch"))).wait();
  console.log("Batch 3: Created -> Funded -> Delivered -> Refunded (rejection)");
  await network.provider.send("evm_setNextBlockTimestamp", [deadline]);
  await (await escrow.refund(2)).wait();
  console.log("Batch 2: Created -> Funded -> Refunded (timeout)");
  console.log("totalEscrowed:", (await escrow.totalEscrowed()).toString());
  console.log("Contract balance:", (await ethers.provider.getBalance(await escrow.getAddress())).toString());
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
