
1. ribbon-v2/RibbonThetaSTETHVault.commitAndClose()
https://github.com/ribbon-finance/ribbon-v2/blob/master/contracts/vaults/STETHVault/RibbonThetaSTETHVault.sol

2. ribbon-v2/RibbonThetaSTETHVault._closeShort(address oldOption)
https://github.com/ribbon-finance/ribbon-v2/blob/master/contracts/vaults/STETHVault/RibbonThetaSTETHVault.sol

3. ribbon-v2/VaultLifecycle.settleShort(address GAMMA_CONTROLLER)
https://github.com/ribbon-finance/ribbon-v2/blob/master/contracts/libraries/VaultLifecycle.sol

4. GammaProtocol/Controller.operate(Actions.ActionArgs[] _actions)
https://github.com/opynfinance/GammaProtocol/blob/master/contracts/core/Controller.sol

5. GammaProtocol/Controller._runActions(Actions.ActionArgs[] _actions)
https://github.com/opynfinance/GammaProtocol/blob/master/contracts/core/Controller.sol

6. GammaProtocol/Controller._settleVault(Actions.SettleVaultArgs _args) 
https://github.com/opynfinance/GammaProtocol/blob/master/contracts/core/Controller.sol
Line 953 require(now >= expiry, "C31");



struct ActionArgs {
    // type of action that is being performed on the system
    ActionType actionType;
    // address of the account owner
    address owner;
    // address which we move assets from or to (depending on the action type)
    address secondAddress;
    // asset that is to be transfered
    address asset;
    // index of the vault that is to be modified (if any)
    uint256 vaultId;
    // amount of asset that is to be transfered
    uint256 amount;
    // each vault can hold multiple short / long / collateral assets but we are restricting the scope to only 1 of each in this version
    // in future versions this would be the index of the short / long / collateral asset that needs to be modified
    uint256 index;
    // any other data that needs to be passed in for arbitrary function calls
    bytes data;
}

struct SettleVaultArgs {
    // address of the account owner
    address owner;
    // index of the vault to which is to be settled
    uint256 vaultId;
    // address to which we transfer the remaining collateral
    address to;
}