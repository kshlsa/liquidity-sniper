import { 
    chain, order, trigger, token, accounts
} from '../config/local.json';
import { ethers, utils } from "ethers";
import { BigNumber } from '@ethersproject/bignumber';
import * as readline from 'readline';
import { TransactionRequest } from '@ethersproject/abstract-provider';

const orderSize = order.size;
const minimumTokens = order.expected_tokens;
const triggerAddress = trigger.address;
const { admin } = accounts;

const bscProvider = new ethers.providers.JsonRpcProvider(
    chain.node, 
    {
        chainId: chain.id,
        name: chain.name,
    }
)

let rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

async function applyConfiguration(
    token: ethers.Contract, 
    pair: string,
    orderAmount: BigNumber,
    trigger: ethers.Contract,
    triggerAdminWallet: ethers.Wallet,
): Promise<boolean> {

    console.log(`\n> Applying trigger configuration`)
    console.log(`  Using admin: ${triggerAdminWallet.address}`)
    console.log(`  Admin balance: ${(await triggerAdminWallet.getBalance()).div(10**18).toString()} BNB`)
    console.log(`  Trigger contract: ${trigger.address}`)

    const { hash } = await trigger.configureSnipe(
        pair,
        orderAmount,
        token.address,
        minimumTokens,
        {
            from: triggerAdminWallet.address,
            gasPrice: utils.parseUnits('10', 'gwei'),
        }
    )

    console.log(`\n> Trigger configuration submitted: ${hash}`)
    const receipt = await bscProvider.waitForTransaction(hash);
    if (receipt.status != 1) {
        console.log(` [ERROR] Tx ${hash} failed: ${receipt}`)
        return false
    }
    console.log(`  Applied configuration succesfully.`)
    return true
}

async function supplyTrigger(
    orderAmount: BigNumber,
    trigger: ethers.Contract,
    triggerAdminWallet: ethers.Wallet,
): Promise<boolean> {

    const wbnbAbi = [
        "function balanceOf(address who) public view returns (uint256)",
    ]
    const wbnbAddress = '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c'
    const wbnb = new ethers.Contract(wbnbAddress, wbnbAbi, bscProvider)
    const triggerBalance = await wbnb.balanceOf(trigger)

    if (triggerBalance.lt(orderAmount)) {
        console.log(`\n> Supplying BNB to trigger contract`)
        const diffAmount = orderAmount.sub(triggerBalance).add(1)
        if ((await triggerAdminWallet.getBalance()).lte(diffAmount.add(21000 * 10**10))) {
            console.log(`  [ERROR] Trigger admin ${triggerAdminWallet.address} has insufficient balance to provide to sniper. Required: ${diffAmount.add(21000 * 6**10).div(10**18).toString()} BNB`)
            return false
        }

        const txReq: TransactionRequest = {
            to: trigger.address,
            value: diffAmount,
        }
        const { hash } = await triggerAdminWallet.sendTransaction(txReq)
    
        console.log(`  Tx supplying BNB for trigger contract ${trigger.address}: ${hash}`)
        const receipt = await bscProvider.waitForTransaction(hash);
        if (receipt.status != 1) {
            console.log(` [ERROR] Tx ${hash} failed at ${triggerAdminWallet.address}: ${receipt}`)
            return false
        }
        console.log(`  Trigger supplied with necessary BNB.`)
    }
    return true
}

async function configureTrigger(token: ethers.Contract, pair: string): Promise<void> {
    const triggerAbi = [
        "function configureSnipe(address _tokenPaired, uint _amountIn, address _tknToBuy,  uint _amountOutMin) external onlyOwner returns(bool)",
    ]
    const trigger = new ethers.Contract(triggerAddress, triggerAbi, bscProvider)
    const triggerAdminWallet = new ethers.Wallet(admin, bscProvider)
    const orderAmount = BigNumber.from(orderSize).mul(10**18)

    let ok = await applyConfiguration(
        token,
        pair,
        orderAmount,
        trigger,
        triggerAdminWallet,
    )
    if (!ok) {
        console.log('[ERROR] Halting.')
        return
    }
    
    ok = await supplyTrigger(orderAmount, trigger, triggerAdminWallet)
    if (!ok) {
        console.log('[ERROR] Halting.')
        return
    }
}

async function promptTrigger(): Promise<void> {
    const erc20Abi = [
        "function symbol() view returns (string)",
    ]
    const erc20 = new ethers.Contract(token.address, erc20Abi, bscProvider)
    const tokenSymbol = await erc20.symbol()

    console.log('> Preparing to configure trigger')
    console.log(`  Token to buy: ${erc20.address}`)
    console.log(`  Order size: ${orderSize} BNB`)
    console.log(`  Min buy: ${minimumTokens} ${tokenSymbol}`)
    console.log('[WARNING] Configuring a trigger will REMOVE any existing ones. Make sure the previous trigger has been already used.')

    rl.question(`\n> Configure new trigger? [y/n]: `, async (answer) => {
        switch(answer.toLowerCase()) {
          case 'y':
            await configureTrigger(erc20, token.pair_address)
            break;
          default:
            console.log('  Configure trigger process ends now.');
        }
        rl.close();
    });
}

promptTrigger()