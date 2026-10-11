const hre = require("hardhat");

async function main() {
  const [deployer, localBuyer, localSupplier] = await hre.ethers.getSigners();
  const local = ["hardhat", "localhost"].includes(hre.network.name);
  const buyer = process.env.BUYER_ADDRESS || (local && localBuyer?.address);
  const supplier = process.env.SUPPLIER_ADDRESS || (local && localSupplier?.address);
  if (!buyer || !supplier) throw new Error("Set BUYER_ADDRESS and SUPPLIER_ADDRESS");
  if (!hre.ethers.isAddress(buyer) || !hre.ethers.isAddress(supplier)) throw new Error("Invalid participant address");
  if (buyer === hre.ethers.ZeroAddress || supplier === hre.ethers.ZeroAddress || buyer.toLowerCase() === supplier.toLowerCase()) {
    throw new Error("Participants must be nonzero and distinct");
  }
  const escrow = await hre.ethers.deployContract("OilGasEscrow", [buyer, supplier]);
  await escrow.waitForDeployment();
  console.log(JSON.stringify({
    network: hre.network.name,
    chainId: (await hre.ethers.provider.getNetwork()).chainId.toString(),
    deployer: deployer.address,
    buyer, supplier,
    contract: await escrow.getAddress(),
    transaction: escrow.deploymentTransaction().hash,
  }, null, 2));
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
