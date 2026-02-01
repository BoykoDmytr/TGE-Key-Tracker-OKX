export const CHAINS = [
  { key:"eth", name:"Ethereum", type:"ws", rpc: process.env.WS_ETH, explorerTx:"https://etherscan.io/tx/" },
  { key:"arb", name:"Arbitrum", type:"ws", rpc: process.env.WS_ARB, explorerTx:"https://arbiscan.io/tx/" },

  { key:"base", name:"Base", type:"http", rpc: process.env.HTTP_BASE_RPC, explorerTx:"https://basescan.org/tx/" },

  // ✅ додай це
  { key:"bsc", name:"BSC", type:"http", rpc: process.env.HTTP_BSC_RPC, explorerTx:"https://bscscan.com/tx/" },
];
