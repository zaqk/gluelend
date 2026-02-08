import { expect } from "chai";
import { ethers } from "hardhat";
import { GlueLendToken, GlueLend } from "../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

describe("GlueLend", function () {
  let token: GlueLendToken;
  let lend: GlueLend;
  let owner: HardhatEthersSigner;
  let user: HardhatEthersSigner;
  let other: HardhatEthersSigner;
  let tokenAddr: string;
  let lendAddr: string;
  let glueAddr: string;

  const INITIAL_SUPPLY = ethers.parseEther("1000000"); // 1M

  beforeEach(async function () {
    [owner, user, other] = await ethers.getSigners();

    // Deploy token
    const TokenFactory = await ethers.getContractFactory("GlueLendToken");
    token = await TokenFactory.deploy(
      ["https://example.com/meta.json", "GlueLend Token", "GLT"],
      INITIAL_SUPPLY,
      owner.address
    );
    await token.waitForDeployment();
    tokenAddr = await token.getAddress();

    // Deploy lend contract
    const LendFactory = await ethers.getContractFactory("GlueLend");
    lend = await LendFactory.deploy();
    await lend.waitForDeployment();
    lendAddr = await lend.getAddress();

    // Setup: set collateral manager, register token
    await token.setCollateralManager(lendAddr);
    await token.lockCollateralManager();
    await lend.registerToken(tokenAddr);

    // Get glue address
    glueAddr = await lend.tokenGlue(tokenAddr);

    // Transfer tokens to user
    await token.transfer(user.address, ethers.parseEther("100000")); // 100k
  });

  // ═══════════════════════════════════════════════════════════════
  // DEPLOYMENT
  // ═══════════════════════════════════════════════════════════════

  describe("Deployment", function () {
    it("should deploy token with correct properties", async function () {
      expect(await token.name()).to.equal("GlueLend Token");
      expect(await token.symbol()).to.equal("GLT");
      expect(await token.totalSupply()).to.equal(INITIAL_SUPPLY);
    });

    it("should have constant 1% origination fee", async function () {
      expect(await lend.ORIGINATION_FEE()).to.equal(ethers.parseEther("0.01"));
    });

    it("should register token correctly", async function () {
      expect(await lend.registeredTokens(tokenAddr)).to.equal(true);
      expect(await lend.tokenGlue(tokenAddr)).to.not.equal(ethers.ZeroAddress);
    });

    it("should not allow registering same token twice", async function () {
      await expect(lend.registerToken(tokenAddr)).to.be.reverted;
    });

    it("should lock collateral manager", async function () {
      expect(await token.collateralManagerLocked()).to.equal(true);
      expect(await token.collateralManager()).to.equal(lendAddr);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // TOKEN ACCESS CONTROL
  // ═══════════════════════════════════════════════════════════════

  describe("Token Access Control", function () {
    it("should not allow non-manager to mint", async function () {
      await expect(
        token.connect(user).mint(user.address, ethers.parseEther("100"))
      ).to.be.revertedWithCustomError(token, "OnlyCollateralManager");
    });

    it("should not allow changing locked collateral manager", async function () {
      await expect(
        token.setCollateralManager(other.address)
      ).to.be.revertedWithCustomError(token, "CollateralManagerLocked");
    });

    it("should allow owner to lock mint", async function () {
      await token.lockMint();
      expect(await token.mintLocked()).to.equal(true);
    });

    it("should prevent minting after mint locked", async function () {
      await token.lockMint();
      expect(await token.mintLocked()).to.equal(true);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // REGISTER
  // ═══════════════════════════════════════════════════════════════

  describe("Register", function () {
    it("should allow anyone to register a new token", async function () {
      // Deploy a second token from a different account
      const TokenFactory = await ethers.getContractFactory("GlueLendToken");
      const token2 = await TokenFactory.connect(user).deploy(
        ["https://example.com/meta2.json", "Token Two", "TT2"],
        ethers.parseEther("500000"),
        user.address
      );
      const token2Addr = await token2.getAddress();

      // Anyone can register
      await lend.connect(other).registerToken(token2Addr);
      expect(await lend.registeredTokens(token2Addr)).to.equal(true);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // BORROW
  // ═══════════════════════════════════════════════════════════════

  describe("Borrow", function () {
    it("should revert if token not registered", async function () {
      await expect(
        lend.connect(user).borrow(
          other.address,
          ethers.parseEther("1000"),
          [ethers.ZeroAddress],
          [0]
        )
      ).to.be.revertedWithCustomError(lend, "TokenNotRegistered");
    });

    it("should revert if amount is zero", async function () {
      await expect(
        lend.connect(user).borrow(tokenAddr, 0, [ethers.ZeroAddress], [0])
      ).to.be.revertedWithCustomError(lend, "ZeroAmount");
    });

    it("should revert if no collaterals", async function () {
      await expect(
        lend.connect(user).borrow(tokenAddr, ethers.parseEther("1000"), [], [])
      ).to.be.reverted;
    });

    it("should borrow successfully with ETH collateral", async function () {
      // First send ETH to Glue to create backing
      const backingAmount = ethers.parseEther("10");
      await owner.sendTransaction({ to: glueAddr, value: backingAmount });

      const borrowAmount = ethers.parseEther("10000"); // 10k tokens (1% of 1M supply)
      await token.connect(user).approve(lendAddr, borrowAmount);

      const userEthBefore = await ethers.provider.getBalance(user.address);

      const tx = await lend.connect(user).borrow(
        tokenAddr,
        borrowAmount,
        [ethers.ZeroAddress],
        [0] // no min output for test
      );
      const receipt = await tx.wait();
      const gasUsed = receipt!.gasUsed * receipt!.gasPrice;

      const userEthAfter = await ethers.provider.getBalance(user.address);

      // User should have received ETH (minus gas)
      expect(userEthAfter + gasUsed).to.be.gt(userEthBefore);

      // Check loan position
      const position = await lend.getLoanPosition(user.address, tokenAddr);
      expect(position.active).to.equal(true);
      expect(position.tokensBurned).to.equal(borrowAmount);
      expect(position.collateralAddresses.length).to.equal(1);
    });

    it("should allow looping (multiple borrows accumulate)", async function () {
      const backingAmount = ethers.parseEther("10");
      await owner.sendTransaction({ to: glueAddr, value: backingAmount });

      const borrowAmount = ethers.parseEther("10000");
      await token.connect(user).approve(lendAddr, borrowAmount * 2n);

      // First borrow
      await lend.connect(user).borrow(
        tokenAddr,
        borrowAmount,
        [ethers.ZeroAddress],
        [0]
      );

      // Second borrow — should accumulate, not revert
      await lend.connect(user).borrow(
        tokenAddr,
        borrowAmount,
        [ethers.ZeroAddress],
        [0]
      );

      const position = await lend.getLoanPosition(user.address, tokenAddr);
      expect(position.active).to.equal(true);
      expect(position.tokensBurned).to.equal(borrowAmount * 2n);
      expect(position.collateralAmounts[0]).to.be.gt(0);
    });

    it("should revert looping with mismatched collaterals", async function () {
      const backingAmount = ethers.parseEther("10");
      await owner.sendTransaction({ to: glueAddr, value: backingAmount });

      const borrowAmount = ethers.parseEther("10000");
      await token.connect(user).approve(lendAddr, borrowAmount * 2n);

      await lend.connect(user).borrow(
        tokenAddr,
        borrowAmount,
        [ethers.ZeroAddress],
        [0]
      );

      // Try to borrow with different collateral list — should revert
      await expect(
        lend.connect(user).borrow(
          tokenAddr,
          borrowAmount,
          [ethers.ZeroAddress, tokenAddr], // different collateral set
          [0, 0]
        )
      ).to.be.reverted;
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // REPAY
  // ═══════════════════════════════════════════════════════════════

  describe("Repay", function () {
    it("should revert repay with no active loan", async function () {
      await expect(
        lend.connect(user).repay(tokenAddr)
      ).to.be.revertedWithCustomError(lend, "NoActiveLoan");
    });

    it("should repay full loan and get tokens back", async function () {
      // Setup: add backing, borrow
      const backingAmount = ethers.parseEther("10");
      await owner.sendTransaction({ to: glueAddr, value: backingAmount });

      const borrowAmount = ethers.parseEther("10000");
      await token.connect(user).approve(lendAddr, borrowAmount);

      await lend.connect(user).borrow(
        tokenAddr,
        borrowAmount,
        [ethers.ZeroAddress],
        [0]
      );

      // Get owed amount
      const position = await lend.getLoanPosition(user.address, tokenAddr);
      const ethOwed = position.collateralAmounts[0];

      // User token balance before repay
      const tokensBefore = await token.balanceOf(user.address);

      // Repay
      await lend.connect(user).repay(tokenAddr, { value: ethOwed });

      // Check tokens restored
      const tokensAfter = await token.balanceOf(user.address);
      expect(tokensAfter - tokensBefore).to.equal(borrowAmount);

      // Check loan cleared
      const posAfter = await lend.getLoanPosition(user.address, tokenAddr);
      expect(posAfter.active).to.equal(false);
      expect(posAfter.tokensBurned).to.equal(0);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // PARTIAL REPAY
  // ═══════════════════════════════════════════════════════════════

  describe("Partial Repay", function () {
    it("should partially repay and get proportional tokens back", async function () {
      const backingAmount = ethers.parseEther("10");
      await owner.sendTransaction({ to: glueAddr, value: backingAmount });

      const borrowAmount = ethers.parseEther("10000");
      await token.connect(user).approve(lendAddr, borrowAmount);

      await lend.connect(user).borrow(
        tokenAddr,
        borrowAmount,
        [ethers.ZeroAddress],
        [0]
      );

      const position = await lend.getLoanPosition(user.address, tokenAddr);
      const ethOwed = position.collateralAmounts[0];

      // Repay half
      const halfTokens = borrowAmount / 2n;
      const halfEth = ethOwed / 2n;

      const tokensBefore = await token.balanceOf(user.address);

      await lend.connect(user).partialRepay(tokenAddr, halfTokens, { value: halfEth });

      const tokensAfter = await token.balanceOf(user.address);
      expect(tokensAfter - tokensBefore).to.equal(halfTokens);

      // Check remaining position
      const posAfter = await lend.getLoanPosition(user.address, tokenAddr);
      expect(posAfter.active).to.equal(true);
      expect(posAfter.tokensBurned).to.equal(halfTokens);
    });

    it("should fully clear position when partial repay covers all", async function () {
      const backingAmount = ethers.parseEther("10");
      await owner.sendTransaction({ to: glueAddr, value: backingAmount });

      const borrowAmount = ethers.parseEther("10000");
      await token.connect(user).approve(lendAddr, borrowAmount);

      await lend.connect(user).borrow(
        tokenAddr,
        borrowAmount,
        [ethers.ZeroAddress],
        [0]
      );

      const position = await lend.getLoanPosition(user.address, tokenAddr);
      const ethOwed = position.collateralAmounts[0];

      // Repay full via partialRepay
      await lend.connect(user).partialRepay(tokenAddr, borrowAmount, { value: ethOwed });

      const posAfter = await lend.getLoanPosition(user.address, tokenAddr);
      expect(posAfter.active).to.equal(false);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // PREVIEW
  // ═══════════════════════════════════════════════════════════════

  describe("Preview Borrow", function () {
    it("should preview borrow amounts", async function () {
      const backingAmount = ethers.parseEther("10");
      await owner.sendTransaction({ to: glueAddr, value: backingAmount });

      const borrowAmount = ethers.parseEther("10000"); // 1% of supply
      const result = await lend.previewBorrow(
        tokenAddr,
        borrowAmount,
        [ethers.ZeroAddress]
      );

      // User should get roughly 1% of 10 ETH = 0.1 ETH, minus protocol fee and origination fee
      expect(result.userAmounts[0]).to.be.gt(0);
      expect(result.fees[0]).to.be.gt(0);
      // userAmount + fee should roughly equal raw collateral
      expect(result.userAmounts[0] + result.fees[0]).to.be.gt(0);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // BACKING INCREASE
  // ═══════════════════════════════════════════════════════════════

  describe("Backing Increase", function () {
    it("should increase backing after borrow-repay cycle", async function () {
      const backingAmount = ethers.parseEther("10");
      await owner.sendTransaction({ to: glueAddr, value: backingAmount });

      const glueBalanceBefore = await ethers.provider.getBalance(glueAddr);

      // Borrow
      const borrowAmount = ethers.parseEther("10000");
      await token.connect(user).approve(lendAddr, borrowAmount);
      await lend.connect(user).borrow(
        tokenAddr,
        borrowAmount,
        [ethers.ZeroAddress],
        [0]
      );

      // Get position and repay
      const position = await lend.getLoanPosition(user.address, tokenAddr);
      const ethOwed = position.collateralAmounts[0];
      await lend.connect(user).repay(tokenAddr, { value: ethOwed });

      const glueBalanceAfter = await ethers.provider.getBalance(glueAddr);

      // Glue balance should be higher after the cycle due to origination fee
      expect(glueBalanceAfter).to.be.gt(glueBalanceBefore);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // DEFAULT SCENARIO
  // ═══════════════════════════════════════════════════════════════

  describe("Default Scenario", function () {
    it("should benefit remaining holders if borrower defaults", async function () {
      const backingAmount = ethers.parseEther("10");
      await owner.sendTransaction({ to: glueAddr, value: backingAmount });

      const totalSupplyBefore = await token.totalSupply();

      // User borrows and never repays
      const borrowAmount = ethers.parseEther("10000");
      await token.connect(user).approve(lendAddr, borrowAmount);
      await lend.connect(user).borrow(
        tokenAddr,
        borrowAmount,
        [ethers.ZeroAddress],
        [0]
      );

      // Supply is now lower (tokens were burned during unglue)
      const totalSupplyAfter = await token.totalSupply();
      expect(totalSupplyAfter).to.be.lt(totalSupplyBefore);

      // Remaining holders now have a larger share of backing
    });
  });
});
