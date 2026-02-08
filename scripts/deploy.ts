import { ethers } from "hardhat";

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deploying with:", deployer.address);

  // 1. Deploy GlueLendToken
  const tokenInfo = [
    "https://example.com/metadata.json", // contractURI
    "GlueLend Token",                     // name
    "GLT",                                // symbol
  ];
  const initialSupply = ethers.parseEther("1000000"); // 1M tokens
  const token = await (
    await ethers.getContractFactory("GlueLendToken")
  ).deploy(tokenInfo, initialSupply, deployer.address);
  await token.waitForDeployment();
  console.log("GlueLendToken:", await token.getAddress());

  // 2. Deploy GlueLend (no constructor args — 1% fee is constant)
  const lend = await (
    await ethers.getContractFactory("GlueLend")
  ).deploy();
  await lend.waitForDeployment();
  console.log("GlueLend:", await lend.getAddress());

  // 3. Set GlueLend as collateral manager and lock it
  const lendAddress = await lend.getAddress();
  await token.setCollateralManager(lendAddress);
  await token.lockCollateralManager();
  console.log("Collateral manager set and locked");

  // 4. Register token in GlueLend
  const tokenAddress = await token.getAddress();
  await lend.registerToken(tokenAddress);
  console.log("Token registered in GlueLend");

  console.log("\nDeployment complete!");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
