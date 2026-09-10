// src/evm/provider.ts
import { createPublicClient, http } from 'viem';
import { bsc, bscTestnet, base, arbitrum, mainnet, avalanche, optimism, xLayer } from 'viem/chains';
const RPC = {
    bsc: process.env.RPC_BSC || '',
    bsc_testnet: process.env.RPC_BSC_TESTNET || '',
    base: process.env.RPC_BASE || '',
    arbitrum: process.env.RPC_ARBITRUM || '',
    ethereum: process.env.RPC_ETHEREUM || '',
    avalanche: process.env.RPC_AVALANCHE || '',
    optimism: process.env.RPC_OPTIMISM || '',
    xlayer: process.env.RPC_XLAYER || '',
};
const CHAIN = {
    bsc,
    bsc_testnet: bscTestnet,
    base,
    arbitrum,
    ethereum: mainnet,
    avalanche,
    optimism,
    xlayer: xLayer,
};
const clients = new Map();
export function getPublicClient(chainKey) {
    const existing = clients.get(chainKey);
    if (existing)
        return existing;
    const url = RPC[chainKey];
    if (!url)
        throw new Error(`Missing RPC for chain ${chainKey}`);
    const client = createPublicClient({
        chain: CHAIN[chainKey],
        transport: http(url),
    });
    clients.set(chainKey, client);
    return client;
}
// Hardcoded fallbacks
const DEFAULT_EXPLORERS = {
    bsc: 'https://bscscan.com/tx/',
    bsc_testnet: 'https://testnet.bscscan.com/tx/',
    base: 'https://basescan.org/tx/',
    arbitrum: 'https://arbiscan.io/tx/',
    ethereum: 'https://etherscan.io/tx/',
    avalanche: 'https://snowtrace.io/tx/',
    optimism: 'https://optimistic.etherscan.io/tx/',
    xlayer: 'https://www.oklink.com/xlayer/tx/',
};
// Env var keys for each chain
const EXPLORER_ENV_KEYS = {
    bsc: 'EXPLORER_BSC',
    bsc_testnet: 'EXPLORER_BSC_TESTNET',
    base: 'EXPLORER_BASE',
    arbitrum: 'EXPLORER_ARBITRUM',
    ethereum: 'EXPLORER_ETHEREUM',
    avalanche: 'EXPLORER_AVALANCHE',
    optimism: 'EXPLORER_OPTIMISM',
    xlayer: 'EXPLORER_XLAYER',
};
export function getExplorerTxUrl(chainKey, txHash) {
    const envKey = EXPLORER_ENV_KEYS[chainKey];
    const baseUrl = (process.env[envKey] || '').trim() || DEFAULT_EXPLORERS[chainKey];
    return `${baseUrl}${txHash}`;
}
