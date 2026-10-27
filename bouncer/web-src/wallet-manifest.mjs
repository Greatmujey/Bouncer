// Curated from NEAR Connect's manifest at hot-dao/near-selector@9cee11c04cfd42f5a420688f808d4aca612b5fde.
// Executor URLs use immutable Git commit IDs; update and review deliberately.
export const WALLET_MANIFEST = {
  "version": "1.1.0",
  "wallets": [
    {
      "id": "meteor-wallet",
      "name": "Meteor Wallet",
      "icon": "https://raw.githubusercontent.com/Meteor-Wallet/meteor_wallet_sdk/main/assets/meteor-logo-svg.svg",
      "description": "The most simple and secure wallet to manage your crypto, access DeFi, and explore Web3",
      "website": "https://meteorwallet.app/",
      "version": "1.1.1",
      "executor": "https://raw.githubusercontent.com/Meteor-Wallet/meteor_wallet_sdk/53a8b39d1aaaf067502c11e49ebb050c75df019e/storage/meteor-near-connect-latest.js",
      "type": "sandbox",
      "features": {
        "signMessage": true,
        "signInWithoutAddKey": true,
        "signInAndSignMessage": true,
        "signAndSendTransaction": true,
        "signAndSendTransactions": true,
        "signInWithFunctionCallKey": true,
        "signDelegateActions": true,
        "mainnet": true,
        "testnet": true
      },
      "platform": {
        "web": "https://wallet.meteorwallet.app",
        "chrome": "https://chromewebstore.google.com/detail/meteor-wallet/pcndjhkinnkaohffealmlmhaepkpmgkb",
        "android": "https://play.google.com/store/apps/details?id=app.meteorwallet.v2",
        "ios": "https://apps.apple.com/us/app/meteor-wallet/id6739558223"
      },
      "permissions": {
        "storage": true,
        "allowsOpen": [
          "https://chromewebstore.google.com",
          "https://wallet.meteorwallet.app",
          "https://meteorwallet.app",
          "meteorwallet://",
          "meteorwalletdev://"
        ],
        "external": [
          "meteorCom",
          "meteorComV2"
        ]
      }
    },
    {
      "id": "ledger",
      "name": "Ledger",
      "icon": "data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%20768.91%20669.35%22%3E%3Cpath%20style%3D%22stroke%3A%23000%22%20d%3D%22M-2.876-2.76h774.662v674.871H-2.876z%22%2F%3E%3Cpath%20d%3D%22M150.057%20422.845v115.877h176.334v-25.698H175.749v-90.179zm443.103%200v90.179H442.519v25.692h176.334V422.845zM326.647%20246.504v176.334h115.872v-23.174H352.34v-153.16zm-176.59-115.877v115.877h25.692v-90.185h150.642v-25.692zm292.462%200v25.692H593.16v90.185h25.693V130.627z%22%20style%3D%22fill%3A%23fff%22%2F%3E%3C%2Fsvg%3E",
      "description": "Sign transactions using hardware Ledger devices",
      "website": "https://ledger.com",
      "version": "1.0.0",
      "executor": "https://raw.githubusercontent.com/near/near-connect-ledger/a705e63c3543982f8d3d788a216e5e5cb53c676d/ledger-executor.js",
      "type": "sandbox",
      "platform": {},
      "features": {
        "signMessage": true,
        "signInWithoutAddKey": true,
        "signInAndSignMessage": true,
        "signInWithFunctionCallKey": true,
        "signAndSendTransaction": true,
        "signAndSendTransactions": true,
        "signDelegateActions": true,
        "mainnet": true,
        "testnet": true
      },
      "permissions": {
        "storage": true,
        "usb": true,
        "hid": true,
        "bluetooth": true
      }
    },
    {
      "id": "nightly-wallet",
      "name": "Nightly Wallet",
      "icon": "https://storage.herewallet.app/upload/6947eb5c14c65a715fb49a08e5937dcecc994bf224b3869b9878bd7a7db068f9.webp",
      "description": "Surf through the multichain Metaverse with Nightly",
      "website": "https://nightly.app",
      "version": "1.0.0",
      "executor": "https://raw.githubusercontent.com/hot-dao/near-selector/9cee11c04cfd42f5a420688f808d4aca612b5fde/repository/nightly.js",
      "type": "sandbox",
      "platform": {
        "chrome": "https://chromewebstore.google.com/detail/nightly/fiikommddbeccaoicoejoniammnalkfa"
      },
      "permissions": {
        "storage": true,
        "external": [
          "nightly.near"
        ],
        "allowsOpen": [
          "https://nightly.app",
          "https://chromewebstore.google.com/detail/nightly/fiikommddbeccaoicoejoniammnalkfa"
        ]
      },
      "features": {
        "signMessage": true,
        "signInWithoutAddKey": true,
        "signInAndSignMessage": true,
        "signInWithFunctionCallKey": true,
        "signAndSendTransaction": true,
        "signAndSendTransactions": true,
        "testnet": true
      }
    }
  ]
};
