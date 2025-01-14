// SPDX-License-Identifier: MIT
pragma solidity =0.8.4;

interface IYearnPricer {
    function setExpiryPriceInOracle(uint256 _expiryTimestamp) external;

    function getPrice() external view returns (uint256);
}
