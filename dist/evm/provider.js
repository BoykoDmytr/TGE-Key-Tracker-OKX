// src/evm/provider.ts
import { createPublicClient, http } from 'viem';
import { bsc, bscTestnet, base, arbitrum } from 'viem/chains';
const RPC = {
    bsc: process.env.RPC_BSC || '',
    bsc_testnet: process.env.RPC_BSC_TESTNET || '',
    base: process.env.RPC_BASE || '',
    arbitrum: process.env.RPC_ARBITRUM || '',
};
const CHAIN = {
    bsc,
    bsc_testnet: bscTestnet,
    base,
    arbitrum,
};
const clients = new Map();
export function getPublicClient(chainKey) {
    const existing = clients.get(chainKey);
    if (existing)
        return existing;
    const url = RPC[chainKey];
    if (!url)
        throw new Error(`Missing RPC for chain ${chainKey}`);
    // Створюємо viem client, але віддаємо як “EvmClient”
    const client = createPublicClient({
        chain: CHAIN[chainKey],
        transport: http(url),
    });
    clients.set(chainKey, client);
    return client;
}
export function getExplorerTxUrl(chainKey, txHash) {
    const fallback = {
        bsc: 'https://bscscan.com/tx/',
        bsc_testnet: 'https://testnet.bscscan.com/tx/',
        base: 'https://basescan.org/tx/',
        arbitrum: 'https://arbiscan.io/tx/',
    };
    return `${fallback[chainKey]}${txHash}`;
}
