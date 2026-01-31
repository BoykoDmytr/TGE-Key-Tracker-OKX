export const CHAINS = [
  { key:"eth", name:"Ethereum", type:"ws", rpc: process.env.WS_ETH, explorerTx:"https://etherscan.io/tx/" },
  { key:"arb", name:"Arbitrum", type:"ws", rpc: process.env.WS_ARB, explorerTx:"https://arbiscan.io/tx/" },

  // Base only if correct JSON-RPC endpoint is provided:
  { key:"base", name:"Base", type:"http", rpc: process.env.HTTP_BASE_RPC, explorerTx:"https://basescan.org/tx/" },
];