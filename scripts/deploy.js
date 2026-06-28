const hre = require("hardhat");

async function main() {
  console.log("Deploying CheesePlot Smart Contract...");

  const CheesePlot = await hre.ethers.getContractFactory("CheesePlot");
  const contract = await CheesePlot.deploy();

  await contract.waitForDeployment();

  console.log("CheesePlot deployed successfully!");
  console.log("Contract Address:", await contract.getAddress());
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
