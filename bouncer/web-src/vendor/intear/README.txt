Intear Wallet NEAR Connect adapter — corresponding source

These files are copied, without modification, from INTEARnear/wallet at
commit e958da12017cdd43b41947e4f201e72aa1135bf6:
https://github.com/INTEARnear/wallet/tree/e958da12017cdd43b41947e4f201e72aa1135bf6
They are licensed under GNU AGPL version 3; see LICENSE.

Bouncer publishes the separately loaded adapter at intear-wallet.executor.js.
The upstream hosted picker HTML is included as a test fixture; production
loads the wallet provider's hosted copy instead. To reproduce the adapter,
from the directory containing this README:

    npm install --no-save esbuild@0.28.2
    npx esbuild web/src/js/near-selector.js --bundle --format=esm --target=es2020 --minify --define:__NEARCONNECT__=true --outfile=intear-wallet.executor.js

This is an independent third-party component. Bouncer's source and its own
MIT license are available at https://github.com/Greatmujey/Bouncer.
