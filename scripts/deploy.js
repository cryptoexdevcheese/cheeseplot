const hre = require("hardhat");

async function main() {
  console.log("Deploying BlockchainSurveyor Smart Contract...");

  const BlockchainSurveyor = await hre.ethers.getContractFactory("BlockchainSurveyor");
  const contract = await BlockchainSurveyor.deploy();

  await contract.waitForDeployment();

  console.log("BlockchainSurveyor deployed successfully!");
  console.log("Contract Address:", await contract.getAddress());
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
