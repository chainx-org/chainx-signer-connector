`@chainx/signer-connector` is used for connecting and interacting with [ChainX signer](https://github.com/chainx-org/chainx-signer/releases).

## Installation

```shell script
npm install @chainx/signer-connector
```

Or

```shell script
yarn add @chainx/signer-connector
```

## How to use

```javascript
import Connector from '@chainx/signer-connector'

// Create the signer connector instance
const connector = new Connector('dapp')(async () => {
  try {
    await connector.link()
  } catch (e) {
    // handle the linking failure case
  }

  // Get current account from signer. If the returned value is not empty, then it have `name` and `address` fields.
  const account = await connector.getCurrentAccount()

  // Get current node from signer. The returned value have `name` and `url` fields.
  const node = await connector.getCurrentNode()

  function accountChangeListener({ from, to }) {
    // `to` is the changed account, you may set this account to your dapp
  }

  function nodeChangeListener({ from, to }) {
    // `to` is the changed node, you may re-init the ChainX instance with this node
  }

  function networkChangeListener({ from, to }) {
    // `to` is the changed network, you may restart your dapp with this network
  }

  connector.listenAccountChange(accountChangeListener)
  connector.listenNodeChange(nodeChangeListener)
  connector.listenNetworkChange(networkChangeListener)

  // Make sure to remove the listener when you don't need them
  connector.removeAccountChangeListener(accountChangeListener)
  connector.removeNodeChangeListener(nodeChangeListener)
  connector.removeNetworkChangeListener(networkChangeListener)
})()
```
