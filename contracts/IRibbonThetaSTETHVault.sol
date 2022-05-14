// SPDX-License-Identifier: UNLICENSED
pragma solidity =0.8.4;

interface IRibbonThetaSTETHVault {
    function WETH() external view returns (address);
    function keeper() external view returns (address);
    function currentOption() external view returns (address);
    function depositETH() external payable;
    function commitAndClose() external;
    function rollToNextOption() external;
    function transfer(address receiptient, uint256 amount) external;
    function initiateWithdraw(uint256 amount) external;
    function completeWithdraw() external;
}
