// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import {StickyAsset} from "@glue-finance/expansions-pack/contracts/base/StickyAsset.sol";

contract GlueLendToken is ERC20, ERC20Burnable, Ownable, StickyAsset {

    address public collateralManager;
    bool public collateralManagerLocked;
    bool public mintLocked;

    error OnlyCollateralManager();
    error CollateralManagerLocked();
    error MintLocked();

    modifier onlyCollateralManager() {
        if (msg.sender != collateralManager) revert OnlyCollateralManager();
        _;
    }

    constructor(
        string[3] memory tokenInfo, // [contractURI, name, symbol]
        uint256 initialSupply,
        address initialOwner
    )
        ERC20(tokenInfo[1], tokenInfo[2])
        Ownable(initialOwner == address(0) ? msg.sender : initialOwner)
        StickyAsset(tokenInfo[0], [true, false]) // fungible, no hooks
    {
        if (initialSupply > 0) {
            _mint(msg.sender, initialSupply);
        }
    }

    function mint(address to, uint256 amount) external onlyCollateralManager {
        if (mintLocked) revert MintLocked();
        _mint(to, amount);
    }

    function setCollateralManager(address _manager) external onlyOwner {
        if (collateralManagerLocked) revert CollateralManagerLocked();
        collateralManager = _manager;
    }

    function lockCollateralManager() external onlyOwner {
        collateralManagerLocked = true;
    }

    function lockMint() external onlyOwner {
        mintLocked = true;
    }
}
