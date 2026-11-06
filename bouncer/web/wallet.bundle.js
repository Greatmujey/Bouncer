var jt=Object.create;var ht=Object.defineProperty;var Kt=Object.getOwnPropertyDescriptor;var Dt=Object.getOwnPropertyNames;var Ft=Object.getPrototypeOf,Rt=Object.prototype.hasOwnProperty;var h=(o,e)=>()=>{try{return e||o((e={exports:{}}).exports,e),e.exports}catch(t){throw e=0,t}};var Ut=(o,e,t,n)=>{if(e&&typeof e=="object"||typeof e=="function")for(let r of Dt(e))!Rt.call(o,r)&&r!==t&&ht(o,r,{get:()=>e[r],enumerable:!(n=Kt(e,r))||n.enumerable});return o};var zt=(o,e,t)=>(t=o!=null?jt(Ft(o)):{},Ut(e||!o||!o.__esModule?ht(t,"default",{value:o,enumerable:!0}):t,o));var _e=h(ae=>{"use strict";Object.defineProperty(ae,"__esModule",{value:!0});ae.LocalStorage=void 0;var Ie=class{async get(e){return typeof window>"u"?null:localStorage.getItem(e)}async set(e,t){typeof window>"u"||localStorage.setItem(e,t)}async remove(e){typeof window>"u"||localStorage.removeItem(e)}};ae.LocalStorage=Ie});var pt=h(Me=>{"use strict";Object.defineProperty(Me,"__esModule",{value:!0});Me.encodeBase58=Bt;var gt="123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";function Bt(o){if(o.length===0)return"";let e=0,t=0;for(;t<o.length&&o[t]===0;)e++,t++;let n=[0];for(;t<o.length;t++){let s=o[t];for(let a=0;a<n.length;++a)s+=n[a]<<8,n[a]=s%58,s=s/58|0;for(;s>0;)n.push(s%58),s=s/58|0}for(;n.length>0&&n[n.length-1]===0;)n.pop();let r="";for(let s=0;s<e;s++)r+=gt[0];for(let s=n.length-1;s>=0;--s)r+=gt[n[s]];return r}});var G=h(ie=>{"use strict";Object.defineProperty(ie,"__esModule",{value:!0});ie.nearActionsToConnectorActions=void 0;var Gt=pt(),Vt=o=>{try{return JSON.parse(new TextDecoder().decode(o))}catch{return o}},Ht=o=>o.enum!=null?o.enum==="fullAccess":"fullAccess"in o,Jt=o=>o.enum!=null?o.enum==="AccountId":"AccountId"in o,Yt=o=>o.map(e=>{if("type"in e)return e;if(e.signedDelegate)throw new Error("SignedDelegate actions cannot be sent through the wallet connector; wallets sign delegates via signDelegateActions");if(e.functionCall)return{type:"FunctionCall",params:{methodName:e.functionCall.methodName,args:Vt(e.functionCall.args),gas:e.functionCall.gas.toString(),deposit:e.functionCall.deposit.toString()}};if(e.deployGlobalContract)return{type:"DeployGlobalContract",params:{code:e.deployGlobalContract.code,deployMode:Jt(e.deployGlobalContract.deployMode)?"AccountId":"CodeHash"}};if(e.createAccount)return{type:"CreateAccount"};if(e.useGlobalContract){let t=e.useGlobalContract.contractIdentifier;return{type:"UseGlobalContract",params:{contractIdentifier:t.AccountId!=null?{accountId:t.AccountId}:{codeHash:(0,Gt.encodeBase58)(t.CodeHash)}}}}if(e.deployContract)return{type:"DeployContract",params:{code:e.deployContract.code}};if(e.deleteAccount)return{type:"DeleteAccount",params:{beneficiaryId:e.deleteAccount.beneficiaryId}};if(e.deleteKey)return{type:"DeleteKey",params:{publicKey:e.deleteKey.publicKey.toString()}};if(e.transfer)return{type:"Transfer",params:{deposit:e.transfer.deposit.toString()}};if(e.stake)return{type:"Stake",params:{stake:e.stake.stake.toString(),publicKey:e.stake.publicKey.toString()}};if(e.addKey){let{permission:t}=e.addKey.accessKey,n;if(t.functionCall)n={receiverId:t.functionCall.receiverId,allowance:t.functionCall.allowance?.toString(),methodNames:t.functionCall.methodNames};else if(Ht(t))n="FullAccess";else throw new Error("Unsupported access-key permission on AddKey: only functionCall and fullAccess can be sent through the wallet connector (pass a ConnectorAction otherwise)");return{type:"AddKey",params:{publicKey:e.addKey.publicKey.toString(),accessKey:{nonce:Number(e.addKey.accessKey.nonce),permission:n}}}}throw new Error("Unsupported action type")});ie.nearActionsToConnectorActions=Yt});var V=h(F=>{"use strict";Object.defineProperty(F,"__esModule",{value:!0});F.isGasKeyAction=void 0;F.assertGasKeyActionsSupported=Zt;var Xt=o=>o.type==="TransferToGasKey"||o.type==="WithdrawFromGasKey"||o.type==="AddKey"&&o.params.gasKeyInfo!=null;F.isGasKeyAction=Xt;function Zt(o,e,t){if(o?.gasKeys)return;let n=e.filter(F.isGasKeyAction).map(r=>r.type);if(n.length!==0)throw new Error(`${t} does not advertise gas-key support (manifest features.gasKeys), so ${[...new Set(n)].join(", ")} cannot be sent through it; a wallet that does not know gasKeyInfo could add a plain key instead. Sign locally with a full-access key, or use a wallet whose manifest sets features.gasKeys.`)}});var ce=h(le=>{"use strict";Object.defineProperty(le,"__esModule",{value:!0});le.uuid4=void 0;var Qt=()=>typeof window<"u"&&typeof window.crypto<"u"&&typeof window.crypto.randomUUID=="function"?window.crypto.randomUUID():"xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g,function(o){let e=Math.random()*16|0;return(o==="x"?e:e&3|8).toString(16)});le.uuid4=Qt});var Te=h(de=>{"use strict";Object.defineProperty(de,"__esModule",{value:!0});de.ParentFrameWallet=void 0;var Pe=G(),Ne=V(),en=ce(),Le=class{connector;manifest;constructor(e,t){this.connector=e,this.manifest=t}callParentFrame(e,t){let n=(0,en.uuid4)();return window.parent.postMessage({type:"near-wallet-injected-request",id:n,method:e,params:t},"*"),new Promise((r,s)=>{let a=l=>{l.data.type==="near-wallet-injected-response"&&l.data.id===n&&(window.removeEventListener("message",a),l.data.success?r(l.data.result):s(l.data.error))};window.addEventListener("message",a)})}async signIn(e){let t=await this.callParentFrame("near:signIn",{network:e?.network??this.connector.network,addFunctionCallKey:e?.addFunctionCallKey});return Array.isArray(t)?t:[t]}async signInAndSignMessage(e){let t=await this.callParentFrame("near:signInAndSignMessage",{network:e?.network??this.connector.network,addFunctionCallKey:e?.addFunctionCallKey,messageParams:e.messageParams});return Array.isArray(t)?t:[t]}async signOut(e){let t={...e,network:e?.network??this.connector.network};await this.callParentFrame("near:signOut",t)}async getAccounts(e){let t={...e,network:e?.network??this.connector.network};return this.callParentFrame("near:getAccounts",t)}async signAndSendTransaction(e){let t=(0,Pe.nearActionsToConnectorActions)(e.actions);(0,Ne.assertGasKeyActionsSupported)(this.manifest.features,t,this.manifest.name);let n={...e,actions:t,network:e.network??this.connector.network};return this.callParentFrame("near:signAndSendTransaction",n)}async signAndSendTransactions(e){let t=e.transactions.map(r=>({actions:(0,Pe.nearActionsToConnectorActions)(r.actions),receiverId:r.receiverId}));(0,Ne.assertGasKeyActionsSupported)(this.manifest.features,t.flatMap(r=>r.actions),this.manifest.name);let n={...e,transactions:t,network:e.network??this.connector.network};return this.callParentFrame("near:signAndSendTransactions",n)}async signMessage(e){let t={...e,network:e.network??this.connector.network};return this.callParentFrame("near:signMessage",t)}async signDelegateActions(e){let t={...e,delegateActions:e.delegateActions.map(n=>({...n,actions:(0,Pe.nearActionsToConnectorActions)(n.actions)})),network:e.network||this.connector.network};return(0,Ne.assertGasKeyActionsSupported)(this.manifest.features,t.delegateActions.flatMap(n=>n.actions),this.manifest.name),this.callParentFrame("near:signDelegateActions",t)}};de.ParentFrameWallet=Le});var We=h(ue=>{"use strict";Object.defineProperty(ue,"__esModule",{value:!0});ue.parseUrl=void 0;var tn=o=>{try{return new URL(o)}catch{return null}};ue.parseUrl=tn});var ft=h(he=>{"use strict";Object.defineProperty(he,"__esModule",{value:!0});he.copyText=void 0;var nn=async o=>{try{await navigator.clipboard.writeText(o);return}catch{}let e=document.createElement("textarea");e.value=o,e.setAttribute("readonly",""),e.style.position="fixed",e.style.opacity="0",document.body.appendChild(e),e.select();try{if(!document.execCommand("copy"))throw new Error("Copy failed")}finally{e.remove()}};he.copyText=nn});var mt=h(N=>{"use strict";Object.defineProperty(N,"__esModule",{value:!0});N.openExternalLink=N.openTelegramLink=N.isTelegramMiniApp=void 0;var $e=()=>{let o=window?.Telegram?.WebApp;return!o||!o.platform||o.platform==="unknown"?null:o},on=()=>{try{return location.hash.includes("tgWebAppData")?!0:!!sessionStorage.getItem("__telegram__initParams")}catch{return!1}},rn=()=>typeof window>"u"?!1:!!$e()||!!window.TelegramWebviewProxy||on();N.isTelegramMiniApp=rn;var wt=(o,e)=>{let t=window.TelegramWebviewProxy;if(t?.postEvent)return t.postEvent(o,JSON.stringify(e));let n=window.external;if(n&&"notify"in n)return n.notify(JSON.stringify({eventType:o,eventData:e}));window.parent!==window&&window.parent.postMessage(JSON.stringify({eventType:o,eventData:e}),"https://web.telegram.org")},sn=o=>{let e=$e();if(e)return e.openTelegramLink(o.toString());wt("web_app_open_tg_link",{path_full:o.pathname+o.search})};N.openTelegramLink=sn;var an=o=>{let e=$e();if(e)return e.openLink(o.toString());wt("web_app_open_link",{url:o.toString()})};N.openExternalLink=an});var qe=h(ge=>{"use strict";Object.defineProperty(ge,"__esModule",{value:!0});ge.EventEmitter=void 0;var Oe=class{events={};on(e,t){this.events[e]||(this.events[e]=[]),this.events[e].push(t)}emit(e,t){this.events[e]?.forEach(n=>n(t))}off(e,t){this.events[e]=this.events[e]?.filter(n=>n!==t)}once(e,t){let n=r=>{t(r),this.off(e,n)};this.on(e,n)}removeAllListeners(e){e?delete this.events[e]:this.events={}}};ge.EventEmitter=Oe});var fe=h(pe=>{"use strict";Object.defineProperty(pe,"__esModule",{value:!0});pe.escapeHtml=yt;pe.html=ln;function yt(o){return o.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#039;")}var je=Symbol("htmlTag");function ln(o,...e){let t=o[0];for(let n=0;n<e.length;n++){for(let r of Array.isArray(e[n])?e[n]:[e[n]]){let s=r?.[je]?r[je]:yt(String(r??""));t+=s}t+=o[n+1]}return Object.freeze({[je]:t,get html(){return t}})}});var bt=h(we=>{"use strict";Object.defineProperty(we,"__esModule",{value:!0});we.css=void 0;var cn=o=>`
${o} * {
  box-sizing: border-box;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol";
  -ms-overflow-style: none; 
  scrollbar-width: none; 
  color: #fff;
}

${o} *::-webkit-scrollbar { 
  display: none;
}

${o} p,
${o} h1,
${o} h2,
${o} h3,
${o} h4,
${o} h5,
${o} h6 {
  margin: 0;
}

${o} .modal-container {
    position: fixed;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    z-index: 100000000;
    background-color: rgba(0, 0, 0, 0.5);
    display: flex;
    justify-content: center;
    align-items: center;
    flex-direction: column;
    transition: opacity 0.2s ease-in-out;
}

@media (max-width: 600px) {
  ${o} .modal-container {
    justify-content: flex-end;
  }
}

${o} .modal-content {
  display: flex;
  flex-direction: column;
  align-items: center;

  max-width: 420px;
  max-height: 615px;
  width: 100%;
  border-radius: 24px;
  background: #0d0d0d;
  border: 1.5px solid rgba(255, 255, 255, 0.1);
  transition: transform 0.2s ease-in-out;
}

@media (max-width: 600px) {
  ${o} .modal-content {
    max-width: 100%;
    width: 100%;
    max-height: 80%;
    border-bottom-left-radius: 0;
    border-bottom-right-radius: 0;
    border: none;
    border-top: 1.5px solid rgba(255, 255, 255, 0.1);
  }
}


${o} .modal-header {
  display: flex;
  padding: 16px;
  gap: 16px;
  align-self: stretch;
  align-items: center;
  justify-content: center;
  position: relative;
}

${o} .modal-header button {
  position: absolute;
  right: 16px;
  top: 16px;
  width: 32px;
  height: 32px;
  border-radius: 12px;
  cursor: pointer;
  transition: background 0.2s ease-in-out;
  border: none;
  background: none;
  display: flex;
  align-items: center;
  justify-content: center;
}

${o} .modal-header button:hover {
  background: rgba(255, 255, 255, 0.04);
}
  
${o} .modal-header p {
  color: #fff;
  text-align: center;
  font-size: 24px;
  font-style: normal;
  font-weight: 600;
  line-height: normal;
  margin: 0;
}


${o} .modal-body {
  display: flex;
  padding: 16px;
  flex-direction: column;
  align-items: flex-start;
  text-align: center;
  gap: 8px;
  overflow: auto;

  border-radius: 24px;
  background: rgba(255, 255, 255, 0.08);
  width: 100%;
  flex: 1;
}

${o} .modal-body textarea {
  width: 100%;
  padding: 12px;
  border-radius: 12px;
  background: #0d0d0d;
  color: #fff;
  border: 1px solid rgba(255, 255, 255, 0.1);
  outline: none;
  font-size: 16px;
  transition: background 0.2s ease-in-out;
  font-family: monospace;
  font-size: 12px;
}

${o} .modal-body button {
  width: 100%;
  padding: 12px;
  border-radius: 12px;
  background: #fff;
  color: #000;
  border: none;
  cursor: pointer;
  font-size: 16px;
  transition: background 0.2s ease-in-out;
  margin-top: 16px;
}

${o} .footer {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: flex-start;
  padding: 16px 24px;
  color: #fff;
  gap: 12px;
}

${o} .modal-body p {
  color: rgba(255, 255, 255, 0.9);
  text-align: center;
  font-size: 16px;
  font-style: normal;
  font-weight: 500;
  line-height: normal;
  letter-spacing: -0.8px;
}

${o} .footer img {
  width: 24px;
  height: 24px;
  border-radius: 50%;
  object-fit: cover;
}

${o} .get-wallet-link {
  color: rgba(255, 255, 255, 0.5);
  text-align: center;
  font-size: 16px;
  font-style: normal;
  font-weight: 500;
  margin-left: auto;
  text-decoration: none;
  transition: color 0.2s ease-in-out;
  cursor: pointer;
}
  
${o} .get-wallet-link:hover {
  color: rgba(255, 255, 255, 1);
}


${o} .connect-item {
  display: flex;
  padding: 8px;
  align-items: center;
  gap: 12px;
  align-self: stretch;
  cursor: pointer;

  transition: background 0.2s ease-in-out;
  border-radius: 24px;
}

${o} .connect-item img {
  width: 48px;
  height: 48px;
  border-radius: 16px;
  object-fit: cover;
  flex-shrink: 0;
}

${o} .connect-item-info {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 4px;
  text-align: left;
  flex: 1;
  margin-top: -2px;
}

${o} .connect-item-info .wallet-address {
  color: rgba(255, 255, 255, 0.5);
  font-size: 14px;
  font-style: normal;
  font-weight: 400;
  line-height: normal;
}

${o} .connect-item:hover {
  background: rgba(255, 255, 255, 0.04);
}

${o} .connect-item img {
  width: 48px;
  height: 48px;
  border-radius: 16px;
  object-fit: cover;
}

${o} .connect-item p {
  color: rgba(255, 255, 255, 0.9);
  text-align: center;
  font-size: 18px;
  font-style: normal;
  font-weight: 600;
  line-height: normal;
  letter-spacing: -0.36px;
  margin: 0;
}
`;we.css=cn});var De=h(me=>{"use strict";Object.defineProperty(me,"__esModule",{value:!0});me.Popup=void 0;var dn=bt(),un=fe(),xt=`n${Math.random().toString(36).substring(2,15)}`;if(typeof document<"u"){let o=document.createElement("style");o.textContent=(0,dn.css)(`.${xt}`),document.head.append(o)}var Ke=class{delegate;isClosed=!1;root=document.createElement("div");state={};constructor(e){this.delegate=e}get dom(){return(0,un.html)``}disposables=[];addListener(e,t,n){let r=typeof e=="string"?this.root.querySelector(e):e;r&&(r.addEventListener(t,n),this.disposables.push(()=>r.removeEventListener(t,n)))}handlers(){this.disposables.forEach(r=>r()),this.disposables=[];let e=this.root.querySelector(".modal-container"),t=this.root.querySelector(".modal-content");t.onclick=r=>r.stopPropagation(),e.onclick=()=>{this.delegate.onReject(),this.destroy()};let n=r=>{r.key==="Escape"&&(this.delegate.onReject(),this.destroy())};document.addEventListener("keydown",n),this.disposables.push(()=>document.removeEventListener("keydown",n))}update(e){this.state={...this.state,...e},this.root.innerHTML=this.dom.html,this.handlers()}create({show:e=!0}){this.root.className=`${xt} hot-connector-popup`,this.root.style.display="none",this.root.innerHTML=this.dom.html,document.body.append(this.root),this.handlers();let t=this.root.querySelector(".modal-container"),n=this.root.querySelector(".modal-content");n.style.transform="translateY(50px)",t.style.opacity="0",e&&setTimeout(()=>this.show(),10)}show(){let e=this.root.querySelector(".modal-container"),t=this.root.querySelector(".modal-content");t.style.transform="translateY(50px)",e.style.opacity="0",this.root.style.display="block",setTimeout(()=>{t.style.transform="translateY(0)",e.style.opacity="1"},100)}hide(){let e=this.root.querySelector(".modal-container"),t=this.root.querySelector(".modal-content");t.style.transform="translateY(50px)",e.style.opacity="0",setTimeout(()=>{this.root.style.display="none"},200)}destroy(){this.isClosed||(this.isClosed=!0,this.disposables.forEach(e=>e()),this.disposables=[],this.hide(),setTimeout(()=>{this.root.remove()},200))}};me.Popup=Ke});var vt=h(ye=>{"use strict";Object.defineProperty(ye,"__esModule",{value:!0});ye.IframeWalletPopup=void 0;var Fe=fe(),hn=De(),Re=class extends hn.Popup{delegate;constructor(e){super(e),this.delegate=e}handlers(){super.handlers(),this.addListener("button","click",()=>this.delegate.onApprove())}create(){super.create({show:!1}),this.root.querySelector(".modal-body").appendChild(this.delegate.iframe),this.delegate.iframe.style.width="100%",this.delegate.iframe.style.height="720px",this.delegate.iframe.style.border="none"}get footer(){if(!this.delegate.footer)return"";let{icon:e,heading:t}=this.delegate.footer;return(0,Fe.html)`
      <div class="footer">
        ${e?(0,Fe.html)`<img src="${e}" alt="${t}" />`:""}
        <p>${t}</p>
      </div>
    `}get dom(){return(0,Fe.html)`<div class="modal-container">
      <div class="modal-content">
        <div class="modal-body" style="padding: 0; overflow: auto;"></div>
        ${this.footer}
      </div>
    </div>`}};ye.IframeWalletPopup=Re});var At=h(be=>{"use strict";Object.defineProperty(be,"__esModule",{value:!0});be.NEAR_CONNECT_VERSION=void 0;be.NEAR_CONNECT_VERSION="0.12.0"});var kt=h(Ue=>{"use strict";Object.defineProperty(Ue,"__esModule",{value:!0});var gn=At();async function pn(o){let e=await o.executor.getAllStorage(),t=o.executor.connector.providers,n=o.executor.manifest,r=o.id,s=o.code.replaceAll(".localStorage",".sandboxedLocalStorage").replaceAll("window.top","window.selector").replaceAll("window.open","window.selector.open"),a=o.cspNonce?` nonce="${o.cspNonce.replace(/[^A-Za-z0-9+/=]/g,"")}"`:"";return`
  <!DOCTYPE html>
  <html>
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
    </head>
    <body>
      <div id="root"></div>

      <style>
        :root {
          --background-color: rgb(40, 40, 40);
          --text-color: rgb(255, 255, 255);
          --border-color: rgb(209, 209, 209);
        }

        * {
          font-family: system-ui, Avenir, Helvetica, Arial, sans-serif
        }

        body, html {
          box-sizing: border-box;
          margin: 0;
          padding: 0;
          background-color: var(--background-color);
          color: var(--text-color);
        }

        #root {
          display: none;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          height: 100vh;
          width: 100vw;
          background: radial-gradient(circle at center, #2c2c2c 0%, #1a1a1a 100%);
          text-align: center;
        }

        #root * {
          box-sizing: border-box;
          font-family: Inter, system-ui, Avenir, Helvetica, Arial, sans-serif;
          line-height: 1.5;
          color-scheme: light dark;
          color: rgb(255, 255, 255);
          font-synthesis: none;
          text-rendering: optimizeLegibility;
          -webkit-font-smoothing: antialiased;
        }

        .prompt-container img {
          width: 100px;
          height: 100px;
          object-fit: cover;
          border-radius: 12px;
        }

        .prompt-container h1 {
          margin: 0;
          font-size: 24px;
          font-weight: 600;
          margin-top: 16px;
        }

        .prompt-container p {
          margin: 0;
          font-size: 16px;
          font-weight: 500;
          color: rgb(209, 209, 209);
        }

        .prompt-container button {
          background-color: #131313;
          border: none;
          border-radius: 12px;
          padding: 12px 24px;
          cursor: pointer;
          transition: border-color 0.25s;
          color: #fff;
          outline: none;
          font-size: 14px;
          font-weight: 500;
          font-family: inherit;
          margin-top: 16px;
        }
      </style>


      <script${a}>
      window.sandboxedLocalStorage = (() => {
        let storage = ${JSON.stringify(e)}

        return {
          setItem: function(key, value) {
            window.selector.storage.set(key, value)
            storage[key] = value || '';
          },
          getItem: function(key) {
            return key in storage ? storage[key] : null;
          },
          removeItem: function(key) {
            window.selector.storage.remove(key)
            delete storage[key];
          },
          get length() {
            return Object.keys(storage).length;
          },
          key: function(i) {
            const keys = Object.keys(storage);
            return keys[i] || null;
          },
        };
      })();

      const showPrompt = async (args) => {
        const root = document.getElementById("root");   
        root.style.display = "flex";
        root.innerHTML = \`
          <div class="prompt-container">
            <img src="${n.icon}" />
            <h1>${n.name}</h1>
            <p>\${args.title}</p>
            <button>\${args.button}</button>
          </div>
        \`;

        return new Promise((resolve) => {
          root.querySelector("button")?.addEventListener("click", () => {
            root.innerHTML = "";
            resolve(true);
          });
        });
      }

      class ProxyWindow {
        constructor(url, features) {
          this.closed = false;
          this.windowIdPromise = window.selector.call("open", { url, features });

          window.addEventListener("message", async (event) => {            
            if (event.data.origin !== "${r}") return;
            if (!event.data.method?.startsWith("proxy-window:")) return;
            const method = event.data.method.replace("proxy-window:", "");
            if (method === "closed" && event.data.windowId === await this.id()) this.closed = true;
          });
        } 

        async id() {
          return await this.windowIdPromise;
        }

        async focus() {
          await window.selector.call("panel.focus", { windowId: await this.id() });
        }

        async postMessage(data) {
          window.selector.call("panel.postMessage", { windowId: await this.id(), data });
        }

        async close() {
          await window.selector.call("panel.close", { windowId: await this.id() });
        }
      }

      window.selector = {
        wallet: null,
        location: "${window.location.href}",
        nearConnectVersion: "${gn.NEAR_CONNECT_VERSION}",
        
        outerHeight: ${window.outerHeight},
        screenY: ${window.screenY},
        outerWidth: ${window.outerWidth},
        screenX: ${window.screenX},

        providers: {
          mainnet: ${JSON.stringify(t.mainnet)},
          testnet: ${JSON.stringify(t.testnet)},
        },

        uuid() {
          return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function (c) {
            const r = (Math.random() * 16) | 0;
            const v = c === "x" ? r : (r & 0x3) | 0x8;
            return v.toString(16);
          });
        },

        walletConnect: {
          connect(params) {
            return window.selector.call("walletConnect.connect", params);
          },
          disconnect(params) {
            return window.selector.call("walletConnect.disconnect", params);
          },
          request(params) {
            return window.selector.call("walletConnect.request", params);
          },
          getProjectId() {
            return window.selector.call("walletConnect.getProjectId", {});
          },
          getSession() {
            return window.selector.call("walletConnect.getSession", {});
          },
        },
      
        async ready(wallet) {
          wallet.manifest = ${JSON.stringify(n)};
          window.parent.postMessage({ method: "wallet-ready", origin: "${r}" }, "*");
          window.selector.wallet = wallet;
        },

        async call(method, params) {
          const id = window.selector.uuid();
          window.parent.postMessage({ method, params, id, origin: "${r}" }, "*");

          return new Promise((resolve, reject) => {
            const handler = (event) => {
              if (event.data.id !== id || event.data.origin !== "${r}") return;
              window.removeEventListener("message", handler);

              if (event.data.status === "failed") reject(event.data.result);
              else resolve(event.data.result);
            };

            window.addEventListener("message", handler);
          });
        },

        panelClosed(windowId) {
          window.parent.postMessage({ 
            method: "panel.closed", 
            origin: "${r}", 
            result: { windowId } 
          }, "*");
        },

        open(url, _, params) {
          return new ProxyWindow(url, params)
        },

        external(entity, key, ...args) {
          return window.selector.call("external", { entity, key, args: args || [] });
        },

        openNativeApp(url) {
          return window.selector.call("open.nativeApp", { url });
        },

        ui: {
          async whenApprove(options) {
            window.selector.ui.showIframe();
            await showPrompt(options);
            window.selector.ui.hideIframe();
          },

          async showIframe() {
            return await window.selector.call("ui.showIframe");
          },

          async hideIframe() {
            return await window.selector.call("ui.hideIframe");
          },
        },

        storage: {
          async set(key, value) {
            await window.selector.call("storage.set", { key, value });
          },
      
          async get(key) {
            return await window.selector.call("storage.get", { key });
          },
      
          async remove(key) {
            await window.selector.call("storage.remove", { key });
          },

          async keys() {
            return await window.selector.call("storage.keys", {});
          },
        },
      };

      // Clipboard API often rejects inside the sandbox (Android WebView), copy through the dApp page then.
      // Plain assignment to navigator.clipboard is a no-op (getter on the prototype), so redefine the method
      const clipboard = navigator.clipboard || {};
      const nativeWriteText = clipboard.writeText ? clipboard.writeText.bind(clipboard) : null;
      Object.defineProperty(clipboard, "writeText", {
        configurable: true,
        value: async (text) => {
          try {
            if (nativeWriteText) return await nativeWriteText(text);
          } catch {}
          await window.selector.call("clipboard.writeText", { text });
        },
      });
      if (!navigator.clipboard) Object.defineProperty(navigator, "clipboard", { configurable: true, value: clipboard });

      window.addEventListener("message", async (event) => {
        if (event.data.origin !== "${r}") return;
        if (!event.data.method?.startsWith("wallet:")) return;
      
        const wallet = window.selector.wallet;
        const method = event.data.method.replace("wallet:", "");
        const payload = { id: event.data.id, origin: "${r}", method };
      
        if (wallet == null || typeof wallet[method] !== "function") {
          const data = { ...payload, status: "failed", result: "Method not found" };
          window.parent.postMessage(data, "*");
          return;
        }
        
        try {
          const result = await wallet[method](event.data.params);
          window.parent.postMessage({ ...payload, status: "success", result }, "*");
        } catch (error) {
          const data = { ...payload, status: "failed", result: error };
          window.parent.postMessage(data, "*");
        }
      });
      <\/script>

      <script type="module"${a}>${s}<\/script>
    </body>
  </html>
    `}Ue.default=pn});var Ct=h(H=>{"use strict";var fn=H&&H.__importDefault||function(o){return o&&o.__esModule?o:{default:o}};Object.defineProperty(H,"__esModule",{value:!0});var wn=qe(),mn=ce(),yn=vt(),bn=fn(kt()),ze=class{executor;origin;disposed=!1;iframe=document.createElement("iframe");events=new wn.EventEmitter;popup;handler;readyPromiseResolve;readyPromise=new Promise(e=>{this.readyPromiseResolve=e});constructor(e,t,n,r){this.executor=e,this.origin=(0,mn.uuid4)(),this.handler=a=>{a.data.origin===this.origin&&(a.data.method==="wallet-ready"&&this.readyPromiseResolve(),n(this,a))},window.addEventListener("message",this.handler);let s=[];this.executor.checkPermissions("usb")&&s.push("usb *;"),this.executor.checkPermissions("hid")&&s.push("hid *;"),this.executor.checkPermissions("clipboardRead")&&s.push("clipboard-read;"),this.executor.checkPermissions("clipboardWrite")&&s.push("clipboard-write;"),this.executor.checkPermissions("bluetooth")&&s.push("bluetooth *;"),this.iframe.allow=s.join(" "),this.iframe.setAttribute("sandbox","allow-scripts"),(0,bn.default)({id:this.origin,executor:this.executor,code:t,cspNonce:r}).then(a=>{this.executor.connector.logger?.log("Iframe code injected"),this.iframe.srcdoc=a}),this.popup=new yn.IframeWalletPopup({footer:this.executor.connector.footerBranding,iframe:this.iframe,onApprove:()=>{},onReject:()=>{this.disposed=!0,window.removeEventListener("message",this.handler),this.events.emit("close",{}),this.popup.destroy()}}),this.popup.create()}on(e,t){this.events.on(e,t)}show(){this.popup.show()}hide(){this.popup.hide()}postMessage(e){if(this.disposed)return;let t=this.iframe.contentWindow;if(!t)throw new Error(`Iframe not loaded for ${e?.method??"unknown method"}`);t.postMessage({...e,origin:this.origin},"*")}dispose(){this.disposed=!0,window.removeEventListener("message",this.handler),this.popup.destroy()}};H.default=ze});var St=h(J=>{"use strict";var xn=J&&J.__importDefault||function(o){return o&&o.__esModule?o:{default:o}};Object.defineProperty(J,"__esModule",{value:!0});var O=We(),Ge=ce(),vn=ft(),Be=mt(),An=xn(Ct()),kn=(0,Ge.uuid4)(),Ve=class{connector;manifest;activePanels={};storageSpace;constructor(e,t){this.connector=e,this.manifest=t,this.storageSpace=t.id}checkPermissions(e,t){if(e==="walletConnect")return!!this.manifest.permissions.walletConnect;if(e==="external"){let n=this.manifest.permissions.external;return!n||!t?.entity?!1:n.includes(t.entity)}if(e==="allowsOpen"){let n=(0,O.parseUrl)(t?.url||""),r=this.manifest.permissions.allowsOpen;return!n||!r||!Array.isArray(r)||r.length===0?!1:r.some(a=>{let l=(0,O.parseUrl)(a);return!(!l||n.protocol!==l.protocol||l.hostname&&n.hostname!==l.hostname||l.pathname&&l.pathname!=="/"&&n.pathname!==l.pathname)})}return this.manifest.permissions[e]}assertPermissions(e,t,n){if(!this.checkPermissions(t,n.data.params))throw e.postMessage({...n.data,status:"failed",result:"Permission denied"}),new Error("Permission denied")}_onMessage=async(e,t)=>{let n=s=>{e.postMessage({...t.data,status:"success",result:s})},r=s=>{e.postMessage({...t.data,status:"failed",result:s})};if(t.data.method==="ui.showIframe"){e.show(),n(null);return}if(t.data.method==="ui.hideIframe"){e.hide(),n(null);return}if(t.data.method==="storage.set"){this.assertPermissions(e,"storage",t),localStorage.setItem(`${this.storageSpace}:${t.data.params.key}`,t.data.params.value),n(null);return}if(t.data.method==="storage.get"){this.assertPermissions(e,"storage",t);let s=localStorage.getItem(`${this.storageSpace}:${t.data.params.key}`);n(s);return}if(t.data.method==="storage.keys"){this.assertPermissions(e,"storage",t);let s=Object.keys(localStorage).filter(a=>a.startsWith(`${this.storageSpace}:`));n(s);return}if(t.data.method==="storage.remove"){this.assertPermissions(e,"storage",t),localStorage.removeItem(`${this.storageSpace}:${t.data.params.key}`),n(null);return}if(t.data.method==="panel.focus"){let s=this.activePanels[t.data.params.windowId];s&&s.focus(),n(null);return}if(t.data.method==="panel.postMessage"){let s=this.activePanels[t.data.params.windowId];s&&s.postMessage(t.data.params.data,"*"),n(null);return}if(t.data.method==="panel.close"){let s=this.activePanels[t.data.params.windowId];s&&s.close(),delete this.activePanels[t.data.params.windowId],n(null);return}if(t.data.method==="walletConnect.connect"){this.assertPermissions(e,"walletConnect",t);try{if(!this.connector.walletConnect)throw new Error("WalletConnect is not configured");let a=await(await this.connector.walletConnect).connect(t.data.params);a.approval(),n({uri:a.uri})}catch(s){r(s)}return}if(t.data.method==="walletConnect.getProjectId"){if(!this.connector.walletConnect)throw new Error("WalletConnect is not configured");this.assertPermissions(e,"walletConnect",t);let s=await this.connector.walletConnect;n(s.core.projectId);return}if(t.data.method==="walletConnect.disconnect"){this.assertPermissions(e,"walletConnect",t);try{if(!this.connector.walletConnect)throw new Error("WalletConnect is not configured");let a=await(await this.connector.walletConnect).disconnect(t.data.params);n(a)}catch(s){r(s)}return}if(t.data.method==="walletConnect.getSession"){this.assertPermissions(e,"walletConnect",t);try{if(!this.connector.walletConnect)throw new Error("WalletConnect is not configured");let s=await this.connector.walletConnect,a=s.session.keys[s.session.keys.length-1],l=a?s.session.get(a):null;n(l?{topic:l.topic,namespaces:l.namespaces}:null)}catch(s){r(s)}return}if(t.data.method==="walletConnect.request"){this.assertPermissions(e,"walletConnect",t);try{if(!this.connector.walletConnect)throw new Error("WalletConnect is not configured");let a=await(await this.connector.walletConnect).request(t.data.params);n(a)}catch(s){r(s)}return}if(t.data.method==="clipboard.writeText"){this.assertPermissions(e,"clipboardWrite",t);try{await(0,vn.copyText)(t.data.params.text),n(null)}catch(s){r(s)}return}if(t.data.method==="external"){this.assertPermissions(e,"external",t);try{let{entity:s,key:a,args:l}=t.data.params,c=s.split(".").reduce((b,A)=>b[A],window);s==="nightly.near"&&a==="signTransaction"&&(l[0].encode=()=>l[0]);let u=typeof c[a]=="function"?await c[a](...l||[]):c[a];n(u)}catch(s){r(s)}return}if(t.data.method==="open"){this.assertPermissions(e,"allowsOpen",t);let s=(0,O.parseUrl)(t.data.params.url);if(s&&s.protocol==="https:"&&(0,Be.isTelegramMiniApp)()){s.hostname==="t.me"?(0,Be.openTelegramLink)(s):(0,Be.openExternalLink)(s),n(null);return}let a=window.open(t.data.params.url,"_blank",t.data.params.features),l=a?(0,Ge.uuid4)():null,c=u=>{let b=(0,O.parseUrl)(t.data.params.url);b&&b.origin===u.origin&&e.postMessage(u.data)};if(n(l),window.addEventListener("message",c),a&&l){this.activePanels[l]=a;let u=setInterval(()=>{if(!a?.closed)return;window.removeEventListener("message",c);let b={method:"proxy-window:closed",windowId:l};delete this.activePanels[l],clearInterval(u);try{e.postMessage(b)}catch{}},500)}return}if(t.data.method==="open.nativeApp"){this.assertPermissions(e,"allowsOpen",t);let s=(0,O.parseUrl)(t.data.params.url);if(!s||["https","http","javascript:","file:","data:","blob:","about:"].includes(s.protocol))throw r("Invalid URL"),new Error("[open.nativeApp] Invalid URL");let l=document.createElement("iframe");l.src=t.data.params.url,l.style.display="none",document.body.appendChild(l),e.postMessage({...t.data,status:"success",result:null});return}};actualCode=null;async checkNewVersion(e,t){if(this.actualCode)return this.connector.logger?.log("New version of code already checked"),this.actualCode;let n=(0,O.parseUrl)(e.manifest.executor);if(n||(n=(0,O.parseUrl)(location.origin+e.manifest.executor)),!n)throw new Error("Invalid executor URL");n.searchParams.set("nonce",kn);let r=await fetch(n.toString()).then(s=>{if(!s.ok)throw new Error(`Failed to load executor: ${s.status}`);return s.text()});return this.connector.logger?.log("New version of code fetched"),this.actualCode=r,r===t?(this.connector.logger?.log("New version of code is the same as the current version"),this.actualCode):(await this.connector.db.setItem(`${this.manifest.id}:${this.manifest.version}`,r).then(()=>this.connector.logger?.log("New version of code saved to cache")).catch(s=>this.connector.logger?.log("Failed to cache new version of code",s)),r)}async loadCode(){let e=await this.connector.db.getItem(`${this.manifest.id}:${this.manifest.version}`).catch(()=>null);this.connector.logger?.log("Code loaded from cache",e!==null);let t=this.checkNewVersion(this,e);return e||await t}async call(e,t){this.connector.logger?.log("Add to queue",e,t),this.connector.logger?.log("Calling method",e,t);let n=await this.loadCode();this.connector.logger?.log("Code loaded, preparing");let r=new An.default(this,n,this._onMessage,this.connector.cspNonce);this.connector.logger?.log("Code loaded, iframe initialized"),await r.readyPromise,this.connector.logger?.log("Iframe ready");let s=(0,Ge.uuid4)();return new Promise((a,l)=>{try{let c=u=>{u.data.id!==s||u.data.origin!==r.origin||(r.dispose(),window.removeEventListener("message",c),this.connector.logger?.log("postMessage",{result:u.data,request:{method:e,params:t}}),u.data.status==="failed"?l(u.data.result):a(u.data.result))};window.addEventListener("message",c),r.postMessage({method:e,params:t,id:s}),r.on("close",()=>l(new Error("Wallet closed")))}catch(c){this.connector.logger?.log("Iframe error",c),l(c)}})}async getAllStorage(){let e=Object.keys(localStorage).filter(n=>n.startsWith(`${this.storageSpace}:`)),t={};for(let n of e)t[n.replace(`${this.storageSpace}:`,"")]=localStorage.getItem(n);return t}async clearStorage(){let e=Object.keys(localStorage).filter(t=>t.startsWith(`${this.storageSpace}:`));for(let t of e)localStorage.removeItem(t)}};J.default=Ve});var Ye=h(q=>{"use strict";var Cn=q&&q.__importDefault||function(o){return o&&o.__esModule?o:{default:o}};Object.defineProperty(q,"__esModule",{value:!0});q.SandboxWallet=void 0;var He=G(),Je=V(),Sn=Cn(St()),xe=class{connector;manifest;executor;constructor(e,t){this.connector=e,this.manifest=t,this.executor=new Sn.default(e,t)}async signIn(e){return this.executor.call("wallet:signIn",{network:e?.network??this.connector.network,addFunctionCallKey:e?.addFunctionCallKey})}async signInAndSignMessage(e){return this.executor.call("wallet:signInAndSignMessage",{network:e?.network??this.connector.network,addFunctionCallKey:e?.addFunctionCallKey,messageParams:e.messageParams})}async signOut(e){let t={...e,network:e?.network??this.connector.network};await this.executor.call("wallet:signOut",t),await this.executor.clearStorage()}async getAccounts(e){let t={...e,network:e?.network??this.connector.network};return this.executor.call("wallet:getAccounts",t)}async signAndSendTransaction(e){let t=(0,He.nearActionsToConnectorActions)(e.actions);(0,Je.assertGasKeyActionsSupported)(this.manifest.features,t,this.manifest.name);let n={...e,actions:t,network:e.network??this.connector.network};return this.executor.call("wallet:signAndSendTransaction",n)}async signAndSendTransactions(e){let t=e.transactions.map(r=>({actions:(0,He.nearActionsToConnectorActions)(r.actions),receiverId:r.receiverId}));(0,Je.assertGasKeyActionsSupported)(this.manifest.features,t.flatMap(r=>r.actions),this.manifest.name);let n={...e,transactions:t,network:e.network??this.connector.network};return this.executor.call("wallet:signAndSendTransactions",n)}async signMessage(e){let t={...e,network:e.network??this.connector.network};return this.executor.call("wallet:signMessage",t)}async signDelegateActions(e){let t={...e,delegateActions:e.delegateActions.map(n=>({...n,actions:(0,He.nearActionsToConnectorActions)(n.actions)})),network:e.network??this.connector.network};return(0,Je.assertGasKeyActionsSupported)(this.manifest.features,t.delegateActions.flatMap(n=>n.actions),this.manifest.name),this.executor.call("wallet:signDelegateActions",t)}};q.SandboxWallet=xe;q.default=xe});var et=h(ve=>{"use strict";Object.defineProperty(ve,"__esModule",{value:!0});ve.InjectedWallet=void 0;var Xe=G(),Ze=V(),Qe=class{connector;wallet;constructor(e,t){this.connector=e,this.wallet=t}get manifest(){return this.wallet.manifest}async signIn({addFunctionCallKey:e,network:t}){return this.wallet.signIn({network:t??this.connector.network,addFunctionCallKey:e})}async signInAndSignMessage(e){return this.wallet.signInAndSignMessage({network:e?.network??this.connector.network,addFunctionCallKey:e.addFunctionCallKey,messageParams:e.messageParams})}async signOut(e){await this.wallet.signOut({network:e?.network??this.connector.network})}async getAccounts(e){return this.wallet.getAccounts({network:e?.network??this.connector.network})}async signAndSendTransaction(e){let t=(0,Xe.nearActionsToConnectorActions)(e.actions);(0,Ze.assertGasKeyActionsSupported)(this.manifest.features,t,this.manifest.name);let n=e.network??this.connector.network,r=await this.wallet.signAndSendTransaction({...e,actions:t,network:n});if(!r)throw new Error("No result from wallet");return Array.isArray(r.transactions)?r.transactions[0]:r}async signAndSendTransactions(e){let t=e.network??this.connector.network,n=e.transactions.map(s=>({actions:(0,Xe.nearActionsToConnectorActions)(s.actions),receiverId:s.receiverId}));(0,Ze.assertGasKeyActionsSupported)(this.manifest.features,n.flatMap(s=>s.actions),this.manifest.name);let r=await this.wallet.signAndSendTransactions({...e,transactions:n,network:t});if(!r)throw new Error("No result from wallet");return Array.isArray(r.transactions)?r.transactions:r}async signMessage(e){return this.wallet.signMessage({...e,network:e.network??this.connector.network})}async signDelegateActions(e){let t=e.delegateActions.map(n=>({...n,actions:(0,Xe.nearActionsToConnectorActions)(n.actions)}));return(0,Ze.assertGasKeyActionsSupported)(this.manifest.features,t.flatMap(n=>n.actions),this.manifest.name),this.wallet.signDelegateActions({...e,delegateActions:t,network:e.network??this.connector.network})}};ve.InjectedWallet=Qe});var Et=h(Ae=>{"use strict";Object.defineProperty(Ae,"__esModule",{value:!0});Ae.NearWalletsPopup=void 0;var R=fe(),En=We(),In=De(),_n={id:"custom-wallet",name:"Custom Wallet",icon:"https://www.mynearwallet.com/images/webclip.png",description:"Custom wallet for NEAR.",website:"",version:"1.0.0",executor:"your-executor-url.js",type:"sandbox",platform:{},features:{signMessage:!0,signInWithoutAddKey:!0,signInAndSignMessage:!0,signAndSendTransaction:!0,signAndSendTransactions:!0,signDelegateActions:!0},permissions:{storage:!0,allowsOpen:[]}},tt=class extends In.Popup{delegate;constructor(e){super(e),this.delegate=e,this.update({wallets:e.wallets,showSettings:!1})}handlers(){super.handlers(),this.addListener(".settings-button","click",()=>this.update({showSettings:!0})),this.addListener(".back-button","click",()=>this.update({showSettings:!1})),this.root.querySelectorAll(".connect-item").forEach(e=>{e instanceof HTMLDivElement&&this.addListener(e,"click",()=>this.delegate.onSelect(e.dataset.type))}),this.root.querySelectorAll(".remove-wallet-button").forEach(e=>{e instanceof SVGSVGElement&&this.addListener(e,"click",async t=>{t.stopPropagation(),await this.delegate.onRemoveDebugManifest(e.dataset.type);let n=this.state.wallets.filter(r=>r.id!==e.dataset.type);this.update({wallets:n})})}),this.addListener(".add-debug-manifest-button","click",async()=>{try{let e=this.root.querySelector("#debug-manifest-input")?.value??"",t=await this.delegate.onAddDebugManifest(e);this.update({showSettings:!1,wallets:[t,...this.state.wallets]})}catch(e){alert(`Something went wrong: ${e}`)}})}create(){super.create({show:!0})}walletDom(e){let t=(0,R.html)`
      <svg
        class="remove-wallet-button"
        data-type="${e.id}"
        width="24"
        height="24"
        viewBox="0 0 24 24"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        style="margin-right: 4px;"
      >
        <path d="M18 6L6 18" stroke="rgba(255,255,255,0.5)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
        <path d="M6 6L18 18" stroke="rgba(255,255,255,0.5)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
    `;return(0,R.html)`
      <div class="connect-item" data-type="${e.id}">
        <img style="background: #333" src="${e.icon}" alt="${e.name}" />
        <div class="connect-item-info">
          <span>${e.name}</span>
          <span class="wallet-address">${(0,En.parseUrl)(e.website)?.hostname}</span>
        </div>
        ${e.debug?t:""}
      </div>
    `}get footer(){if(!this.delegate.footer)return"";let{icon:e,heading:t,link:n,linkText:r}=this.delegate.footer;return(0,R.html)`
      <div class="footer">
        ${e?(0,R.html)`<img src="${e}" alt="${t}" />`:""}
        <p>${t}</p>
        <a class="get-wallet-link" href="${n}" target="_blank">${r}</a>
      </div>
    `}get dom(){return this.state.showSettings?(0,R.html)`
        <div class="modal-container">
          <div class="modal-content">
            <div class="modal-header">
              <button class="back-button" style="left: 16px; right: unset;">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <path d="M15 18L9 12L15 6" stroke="rgba(255,255,255,0.5)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
                </svg>
              </button>
              <p>Settings</p>
            </div>

            <div class="modal-body">
              <p style="text-align: left;">
                You can add your wallet to dapp for debug,
                <a href="https://github.com/azbang/hot-connector" target="_blank">read the documentation.</a> Paste your manifest and click "Add".
              </p>

              <textarea style="width: 100%;" id="debug-manifest-input" rows="10">${JSON.stringify(_n,null,2)}</textarea>
              <button class="add-debug-manifest-button">Add</button>
            </div>

            ${this.footer}
          </div>
        </div>
      `:(0,R.html)`<div class="modal-container">
      <div class="modal-content">
        <div class="modal-header">
          <p>Select wallet</p>
          <button class="settings-button">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
              <circle cx="12" cy="12" r="2" fill="rgba(255,255,255,0.5)" />
              <circle cx="19" cy="12" r="2" fill="rgba(255,255,255,0.5)" />
              <circle cx="5" cy="12" r="2" fill="rgba(255,255,255,0.5)" />
            </svg>
          </button>
        </div>

        <div class="modal-body">${this.state.wallets.map(e=>this.walletDom(e))}</div>

        ${this.footer}
      </div>
    </div>`}};Ae.NearWalletsPopup=tt});var It=h(ot=>{"use strict";Object.defineProperty(ot,"__esModule",{value:!0});var nt=class{dbName;storeName;version;constructor(e,t){this.dbName=e,this.storeName=t,this.version=1}getDb(){return new Promise((e,t)=>{if(typeof window>"u"||typeof indexedDB>"u"){t(new Error("IndexedDB is not available (SSR environment)"));return}let n=indexedDB.open(this.dbName,this.version);n.onerror=r=>{console.error("Error opening database:",r.target.error),t(new Error("Error opening database"))},n.onsuccess=r=>{e(n.result)},n.onupgradeneeded=r=>{let s=n.result;s.objectStoreNames.contains(this.storeName)||s.createObjectStore(this.storeName)}})}async getItem(e){let t=await this.getDb();if(typeof e=="number"&&(e=e.toString()),typeof e!="string")throw new Error("Key must be a string");return new Promise((n,r)=>{if(!this.storeName){r(new Error("Store name not set"));return}let s=t.transaction(this.storeName,"readonly");s.onerror=c=>r(s.error);let l=s.objectStore(this.storeName).get(e);l.onerror=c=>r(l.error),l.onsuccess=()=>{n(l.result),t.close()}})}async setItem(e,t){let n=await this.getDb();if(typeof e=="number"&&(e=e.toString()),typeof e!="string")throw new Error("Key must be a string");return new Promise((r,s)=>{if(!this.storeName){s(new Error("Store name not set"));return}let a=n.transaction(this.storeName,"readwrite");a.onerror=u=>s(a.error);let c=a.objectStore(this.storeName).put(t,e);c.onerror=u=>s(c.error),c.onsuccess=()=>{n.close(),r()}})}async removeItem(e){let t=await this.getDb();if(typeof e=="number"&&(e=e.toString()),typeof e!="string")throw new Error("Key must be a string");return new Promise((n,r)=>{if(!this.storeName){r(new Error("Store name not set"));return}let s=t.transaction(this.storeName,"readwrite");s.onerror=c=>r(s.error);let l=s.objectStore(this.storeName).delete(e);l.onerror=c=>r(l.error),l.onsuccess=()=>{t.close(),n()}})}async keys(){let e=await this.getDb();return new Promise((t,n)=>{if(!this.storeName){n(new Error("Store name not set"));return}let r=e.transaction(this.storeName,"readonly");r.onerror=l=>n(r.error);let a=r.objectStore(this.storeName).getAllKeys();a.onerror=l=>n(a.error),a.onsuccess=()=>{t(a.result),e.close()}})}async count(){let e=await this.getDb();return new Promise((t,n)=>{if(!this.storeName){n(new Error("Store name not set"));return}let r=e.transaction(this.storeName,"readonly");r.onerror=l=>n(r.error);let a=r.objectStore(this.storeName).count();a.onerror=l=>n(a.error),a.onsuccess=()=>{t(a.result),e.close()}})}async length(){return this.count()}async clear(){let e=await this.getDb();return new Promise((t,n)=>{if(!this.storeName){n(new Error("Store name not set"));return}let r=e.transaction(this.storeName,"readwrite");r.onerror=l=>n(r.error);let a=r.objectStore(this.storeName).clear();a.onerror=l=>n(a.error),a.onsuccess=()=>{e.close(),t()}})}};ot.default=nt});var Mt=h(U=>{"use strict";var Mn=U&&U.__importDefault||function(o){return o&&o.__esModule?o:{default:o}};Object.defineProperty(U,"__esModule",{value:!0});U.NearConnector=void 0;var Pn=qe(),Nn=Et(),Ln=_e(),Tn=Mn(It()),Wn=Te(),$n=et(),_t=Ye(),On=["https://raw.githubusercontent.com/hot-dao/near-selector/refs/heads/main/repository/manifest.json","https://cdn.jsdelivr.net/gh/azbang/hot-connector/repository/manifest.json"];function qn(o){return e=>Object.entries(o).length===0?!0:Object.entries(o).filter(([t,n])=>n===!0).every(([t])=>e.manifest.features?.[t]===!0)}var rt=class{storage;events;db;logger;wallets=[];manifest={wallets:[],version:"1.0.0"};features={};network="mainnet";providers={mainnet:[],testnet:[]};walletConnect;footerBranding;excludedWallets=[];autoConnect;cspNonce;whenManifestLoaded;constructor(e){this.db=new Tn.default("hot-connector","wallets"),this.storage=e?.storage??new Ln.LocalStorage,this.events=e?.events??new Pn.EventEmitter,this.logger=e?.logger,this.cspNonce=e?.cspNonce,this.network=e?.network??"mainnet",this.walletConnect=e?.walletConnect,this.autoConnect=e?.autoConnect??!0,this.providers=e?.providers??{mainnet:[],testnet:[]},this.excludedWallets=e?.excludedWallets??[],this.features=e?.features??{},e?.footerBranding!==void 0?this.footerBranding=e?.footerBranding:this.footerBranding={icon:"data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20fill%3D%22none%22%20viewBox%3D%220%200%20512%20512%22%20class%3D%22size-7%22%3E%3Crect%20width%3D%22512%22%20height%3D%22512%22%20fill%3D%22%2300ec97%22%20rx%3D%22110%22%2F%3E%3Cpath%20fill%3D%22%23000%22%20d%3D%22M373.89%20106.199a31.95%2031.95%200%200%200-27.213%2015.207l-62.631%2092.979a6.67%206.67%200%200%200-.989%205.001%206.66%206.66%200%200%200%202.837%204.235%206.67%206.67%200%200%200%208.032-.494l61.643-53.47c1.02-.924%202.599-.827%203.523.193.419.473.644%201.074.644%201.697v167.402a2.49%202.49%200%200%201-2.502%202.491%202.48%202.48%200%200%201-1.912-.891L168.976%20117.497a31.93%2031.93%200%200%200-24.356-11.298h-6.508c-17.623%200-31.917%2014.294-31.917%2031.917v235.767c0%2017.623%2014.294%2031.917%2031.917%2031.917a31.94%2031.94%200%200%200%2027.213-15.206l62.631-92.98a6.66%206.66%200%200%200-1.847-9.236%206.67%206.67%200%200%200-8.033.494l-61.643%2053.471c-1.02.923-2.599.826-3.522-.194a2.5%202.5%200%200%201-.634-1.697V173.008a2.49%202.49%200%200%201%202.502-2.492c.731%200%201.439.322%201.912.891l186.313%20223.096a31.95%2031.95%200%200%200%2024.357%2011.297h6.508c17.623%200%2031.927-14.272%2031.938-31.895V138.116c0-17.623-14.294-31.917-31.917-31.917%22%2F%3E%3C%2Fsvg%3E",heading:"NEAR Connector",link:"https://wallet.near.org",linkText:"Don't have a wallet?"},this.whenManifestLoaded=new Promise(async t=>{e?.manifest==null||typeof e.manifest=="string"?this.manifest=await this._loadManifest(e?.manifest).catch(()=>({wallets:[],version:"1.0.0"})):this.manifest=e?.manifest??{wallets:[],version:"1.0.0"};let n=new Set(this.excludedWallets);n.delete("hot-wallet"),this.manifest.wallets=this.manifest.wallets.filter(r=>!(r.permissions.walletConnect&&!this.walletConnect||n.has(r.id))),await new Promise(r=>setTimeout(r,100)),t()}),typeof window<"u"&&(window.addEventListener("near-wallet-injected",this._handleNearWalletInjected),window.dispatchEvent(new Event("near-selector-ready")),window.addEventListener("message",async t=>{t.data.type==="near-wallet-injected"&&(await this.whenManifestLoaded.catch(()=>{}),this.wallets=this.wallets.filter(n=>n.manifest.id!==t.data.manifest.id),this.wallets.unshift(new Wn.ParentFrameWallet(this,t.data.manifest)),this.events.emit("selector:walletsChanged",{}),this.autoConnect&&this.connect({walletId:t.data.manifest.id}))})),this.whenManifestLoaded.then(()=>{typeof window<"u"&&window.parent.postMessage({type:"near-selector-ready"},"*"),this.manifest.wallets.forEach(t=>this.registerWallet(t)),this.storage.get("debug-wallets").then(t=>{JSON.parse(t??"[]").forEach(r=>this.registerDebugWallet(r))})})}get availableWallets(){return this.wallets.filter(t=>Object.entries(this.features).every(([n,r])=>!(r&&!t.manifest.features?.[n]))).filter(t=>!(this.network==="testnet"&&!t.manifest.features?.testnet))}_handleNearWalletInjected=e=>{this.wallets=this.wallets.filter(t=>t.manifest.id!==e.detail.manifest.id),this.wallets.unshift(new $n.InjectedWallet(this,e.detail)),this.events.emit("selector:walletsChanged",{})};async _loadManifest(e){let t=e?[e]:On;for(let n of t){let r=await fetch(n).catch(()=>null);if(!(!r||!r.ok))return await r.json()}throw new Error("Failed to load manifest")}async switchNetwork(e,t){this.network!==e&&(await this.disconnect().catch(()=>{}),this.network=e,await this.connect(t))}async registerWallet(e){if(e.type!=="sandbox")throw new Error("Only sandbox wallets are supported");this.wallets.find(t=>t.manifest.id===e.id)||(this.wallets.push(new _t.SandboxWallet(this,e)),this.events.emit("selector:walletsChanged",{}))}async registerDebugWallet(e){let t=typeof e=="string"?JSON.parse(e):e;if(t.type!=="sandbox")throw new Error("Only sandbox wallets type are supported");if(!t.id)throw new Error("Manifest must have an id");if(!t.name)throw new Error("Manifest must have a name");if(!t.icon)throw new Error("Manifest must have an icon");if(!t.website)throw new Error("Manifest must have a website");if(!t.version)throw new Error("Manifest must have a version");if(!t.executor)throw new Error("Manifest must have an executor");if(!t.features)throw new Error("Manifest must have features");if(!t.permissions)throw new Error("Manifest must have permissions");if(this.wallets.find(r=>r.manifest.id===t.id))throw new Error("Wallet already registered");t.debug=!0,this.wallets.unshift(new _t.SandboxWallet(this,t)),this.events.emit("selector:walletsChanged",{});let n=this.wallets.filter(r=>r.manifest.debug).map(r=>r.manifest);return this.storage.set("debug-wallets",JSON.stringify(n)),t}async removeDebugWallet(e){this.wallets=this.wallets.filter(n=>n.manifest.id!==e);let t=this.wallets.filter(n=>n.manifest.debug).map(n=>n.manifest);this.storage.set("debug-wallets",JSON.stringify(t)),this.events.emit("selector:walletsChanged",{})}async selectWallet({features:e={}}={}){return await this.whenManifestLoaded.catch(()=>{}),new Promise((t,n)=>{let r=new Nn.NearWalletsPopup({footer:this.footerBranding,wallets:this.availableWallets.filter(qn(e)).map(s=>s.manifest),onRemoveDebugManifest:async s=>this.removeDebugWallet(s),onAddDebugManifest:async s=>this.registerDebugWallet(s),onReject:()=>(n(new Error("User rejected")),r.destroy()),onSelect:s=>(t(s),r.destroy())});r.create()})}async connect(e={}){let t=e.walletId,n=e.signMessageParams;await this.whenManifestLoaded.catch(()=>{}),t||(t=await this.selectWallet({features:{signInAndSignMessage:e.signMessageParams!=null?!0:void 0,signInWithFunctionCallKey:e.addFunctionCallKey!=null?!0:void 0}}));try{let r=await this.wallet(t);this.logger?.log("Wallet available to connect",r),await this.storage.set("selected-wallet",t),this.logger?.log(`Set preferred wallet, try to signIn${n!=null?" (with signed message)":""}`,t);let s;if(e.addFunctionCallKey!=null&&(this.logger?.log("Adding function call access key during sign in with params",e.addFunctionCallKey),s={...e.addFunctionCallKey,gasAllowance:e.addFunctionCallKey.gasAllowance??{amount:"250000000000000000000000",kind:"limited"}}),n!=null){let a=await r.signInAndSignMessage({addFunctionCallKey:s,messageParams:n,network:this.network});if(!a?.length)throw new Error("Failed to sign in");this.logger?.log("Signed in to wallet (with signed message)",t,a),this.events.emit("wallet:signInAndSignMessage",{wallet:r,accounts:a,success:!0}),this.events.emit("wallet:signIn",{wallet:r,accounts:a.map(l=>({accountId:l.accountId,publicKey:l.publicKey})),success:!0,source:"signInAndSignMessage"})}else{let a=await r.signIn({addFunctionCallKey:s,network:this.network});if(!a?.length)throw new Error("Failed to sign in");this.logger?.log("Signed in to wallet",t,a),this.events.emit("wallet:signIn",{wallet:r,accounts:a,success:!0,source:"signIn"})}return r}catch(r){throw this.logger?.log("Failed to connect to wallet",r),r}}async disconnect(e){e||(e=await this.wallet()),await e.signOut({network:this.network}),await this.storage.remove("selected-wallet"),this.events.emit("wallet:signOut",{success:!0})}async getConnectedWallet(){await this.whenManifestLoaded.catch(()=>{});let e=await this.storage.get("selected-wallet"),t=this.wallets.find(r=>r.manifest.id===e);if(!t)throw new Error("No wallet selected");let n=await t.getAccounts();if(!n?.length)throw new Error("No accounts found");return{wallet:t,accounts:n}}async wallet(e){if(await this.whenManifestLoaded.catch(()=>{}),!e)return this.getConnectedWallet().then(({wallet:n})=>n).catch(async()=>{throw await this.storage.remove("selected-wallet"),new Error("No accounts found")});let t=this.wallets.find(n=>n.manifest.id===e);if(!t)throw new Error("Wallet not found");return t}async use(e){await this.whenManifestLoaded.catch(()=>{}),this.wallets=this.wallets.map(t=>new Proxy(t,{get(n,r,s){let a=Reflect.get(n,r,s);if(r in e&&typeof a=="function"){let l=e[r];return function(...c){let u=()=>a.apply(n,c);return c.length>0?l.call(this,...c,u):l.call(this,void 0,u)}}return a}}))}on(e,t){this.events.on(e,t)}once(e,t){this.events.once(e,t)}off(e,t){this.events.off(e,t)}removeAllListeners(e){this.events.removeAllListeners(e)}};U.NearConnector=rt});var Nt=h(p=>{"use strict";Object.defineProperty(p,"__esModule",{value:!0});p.assertGasKeyActionsSupported=p.isGasKeyAction=p.nearActionsToConnectorActions=p.NearConnector=p.InjectedWallet=p.SandboxWallet=p.ParentFrameWallet=p.LocalStorage=void 0;var jn=_e();Object.defineProperty(p,"LocalStorage",{enumerable:!0,get:function(){return jn.LocalStorage}});var Kn=Te();Object.defineProperty(p,"ParentFrameWallet",{enumerable:!0,get:function(){return Kn.ParentFrameWallet}});var Dn=Ye();Object.defineProperty(p,"SandboxWallet",{enumerable:!0,get:function(){return Dn.SandboxWallet}});var Fn=et();Object.defineProperty(p,"InjectedWallet",{enumerable:!0,get:function(){return Fn.InjectedWallet}});var Rn=Mt();Object.defineProperty(p,"NearConnector",{enumerable:!0,get:function(){return Rn.NearConnector}});var Un=G();Object.defineProperty(p,"nearActionsToConnectorActions",{enumerable:!0,get:function(){return Un.nearActionsToConnectorActions}});var Pt=V();Object.defineProperty(p,"isGasKeyAction",{enumerable:!0,get:function(){return Pt.isGasKeyAction}});Object.defineProperty(p,"assertGasKeyActionsSupported",{enumerable:!0,get:function(){return Pt.assertGasKeyActionsSupported}})});var ke=zt(Nt(),1);var Y={version:"1.2.0",wallets:[{id:"near-mobile",name:"NEAR Mobile",icon:"https://storage.herewallet.app/upload/179839f01189bc54afea2fd34eb092ddb6d63c97b5c8c9e418317285fd751f0c.webp",description:"NEAR Mobile message-only testnet connection",website:"https://nearmobile.app",executor:"https://raw.githubusercontent.com/fastnear/near-connect/2341919b6db451e59f3ff96cd91205a4b03f32d9/repository/near-mobile.js",type:"sandbox",version:"1.0.0",features:{signMessage:!0,signInWithoutAddKey:!1,signAndSendTransaction:!0,signAndSendTransactions:!0,testnet:!0},platform:{android:"https://play.google.com/store/apps/details?id=com.peersyst.nearmobilewallet",ios:"https://apps.apple.com/us/app/near-mobile-crypto-wallet/id6443501225"},permissions:{storage:!0,allowsOpen:["https://near-mobile-signer-backend_production.peersyst.tech","https://nearmobile.app","https://play.google.com","https://apps.apple.com"]}},{id:"meteor-wallet",name:"Meteor Wallet",icon:"https://raw.githubusercontent.com/Meteor-Wallet/meteor_wallet_sdk/main/assets/meteor-logo-svg.svg",description:"The most simple and secure wallet to manage your crypto, access DeFi, and explore Web3",website:"https://meteorwallet.app/",version:"1.1.1",executor:"https://raw.githubusercontent.com/Meteor-Wallet/meteor_wallet_sdk/53a8b39d1aaaf067502c11e49ebb050c75df019e/storage/meteor-near-connect-latest.js",type:"sandbox",features:{signMessage:!0,signInWithoutAddKey:!0,signInAndSignMessage:!0,signAndSendTransaction:!0,signAndSendTransactions:!0,signInWithFunctionCallKey:!0,signDelegateActions:!0,mainnet:!0,testnet:!0},platform:{web:"https://wallet.meteorwallet.app",chrome:"https://chromewebstore.google.com/detail/meteor-wallet/pcndjhkinnkaohffealmlmhaepkpmgkb",android:"https://play.google.com/store/apps/details?id=app.meteorwallet.v2",ios:"https://apps.apple.com/us/app/meteor-wallet/id6739558223"},permissions:{storage:!0,allowsOpen:["https://chromewebstore.google.com","https://wallet.meteorwallet.app","https://meteorwallet.app","meteorwallet://","meteorwalletdev://"],external:["meteorCom","meteorComV2"]}},{id:"intear-wallet",name:"Intear Wallet",icon:"data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' width='49.152' height='49.152' viewBox='0 0 36.864 36.864' fill='%230079fb'><path d='M18.487 32.306c-4.599.067-8.487-3.315-9.181-7.846-.278-1.81.068-3.077.628-4.791 1.403-4.291 3.971-8.695 6.427-12.51l.949-1.478c.309-.484.487-1.03 1.115-1.125.512.052.64.423.897.807 2.484 3.706 8.36 13.272 8.334 17.704-.029 5.044-4.068 9.27-9.169 9.238zm-.063-25.712c-2.557 3.771-4.933 7.827-6.631 12.055-.838 2.086-1.485 3.738-1.052 5.983.693 3.599 3.997 6.409 7.684 6.303 4.346.06 7.767-3.49 7.827-7.766.042-2.97-3.226-9.081-4.764-11.757-.373-.65-2.709-4.575-3.064-4.818zM13.18 24.15c-.768.067-.771-.701-.769-1.27.004-1.585.41-2.564.69-3.114.179-.512.807-1.39 1.38-1.807.334-.208.836-.51 1.137-.21.362.547.163.6-.06.906a6.14 6.14 0 0 0-1.754 4.195c-.003.577.098 1.181-.625 1.299zm7.543 5.012c-.598-.034-.626-.334-.735-.811.143-.444.303-.695.753-.698 1.166-.664 2.362-1.655 2.564-3.328.194-.569.104-1.219.864-1.332.852 0 .743 1.326.622 1.885-.923 2.883-2.483 3.648-4.068 4.284z'/></svg>",description:"A fast and secure wallet for everyday interactions with dapps",website:"https://intea.rs/",version:"1.0.0",executor:"/intear-wallet.executor.js",type:"sandbox",features:{signMessage:!0,signTransaction:!1,signAndSendTransaction:!0,signAndSendTransactions:!0,signInWithoutAddKey:!0,verifyOwner:!1,testnet:!0,signDelegateActions:!0,signInAndSignMessage:!0,signInWithFunctionCallKey:!0},platform:{web:"https://wallet.intear.tech"},permissions:{storage:!0,location:!0,allowsOpen:["https://wallet.intear.tech","https://staging.wallet.intear.tech","intear://"]}},{id:"nightly-wallet",name:"Nightly Wallet",icon:"https://storage.herewallet.app/upload/6947eb5c14c65a715fb49a08e5937dcecc994bf224b3869b9878bd7a7db068f9.webp",description:"Surf through the multichain Metaverse with Nightly",website:"https://nightly.app",version:"1.0.0",executor:"https://raw.githubusercontent.com/hot-dao/near-selector/9cee11c04cfd42f5a420688f808d4aca612b5fde/repository/nightly.js",type:"sandbox",platform:{chrome:"https://chromewebstore.google.com/detail/nightly/fiikommddbeccaoicoejoniammnalkfa"},permissions:{storage:!0,external:["nightly.near"],allowsOpen:["https://nightly.app","https://chromewebstore.google.com/detail/nightly/fiikommddbeccaoicoejoniammnalkfa"]},features:{signMessage:!0,signInWithoutAddKey:!0,signInAndSignMessage:!0,signInWithFunctionCallKey:!0,signAndSendTransaction:!0,signAndSendTransactions:!0,testnet:!0}},{id:"ledger",name:"Ledger",icon:"data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%20768.91%20669.35%22%3E%3Cpath%20style%3D%22stroke%3A%23000%22%20d%3D%22M-2.876-2.76h774.662v674.871H-2.876z%22%2F%3E%3Cpath%20d%3D%22M150.057%20422.845v115.877h176.334v-25.698H175.749v-90.179zm443.103%200v90.179H442.519v25.692h176.334V422.845zM326.647%20246.504v176.334h115.872v-23.174H352.34v-153.16zm-176.59-115.877v115.877h25.692v-90.185h150.642v-25.692zm292.462%200v25.692H593.16v90.185h25.693V130.627z%22%20style%3D%22fill%3A%23fff%22%2F%3E%3C%2Fsvg%3E",description:"Sign transactions using hardware Ledger devices",website:"https://ledger.com",version:"1.0.0",executor:"https://raw.githubusercontent.com/near/near-connect-ledger/a705e63c3543982f8d3d788a216e5e5cb53c676d/ledger-executor.js",type:"sandbox",platform:{},features:{signMessage:!0,signInWithoutAddKey:!0,signInAndSignMessage:!0,signInWithFunctionCallKey:!0,signAndSendTransaction:!0,signAndSendTransactions:!0,signDelegateActions:!0,mainnet:!0,testnet:!0},permissions:{storage:!0,usb:!0,hid:!0,bluetooth:!0}},{id:"near-cli",name:"NEAR CLI",icon:"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='64' height='64' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' rx='12' fill='%231a1a2e'/%3E%3Cpolyline points='18 40 28 30 18 20' fill='none' stroke='%2300d4aa' stroke-width='3' stroke-linecap='round' stroke-linejoin='round'/%3E%3Cline x1='32' y1='42' x2='46' y2='42' stroke='%2300d4aa' stroke-width='3' stroke-linecap='round'/%3E%3C/svg%3E",description:"Sign transactions using near-cli-rs in your terminal",website:"https://near.cli.rs",version:"1.0.0",executor:"https://raw.githubusercontent.com/near/near-cli-connect/dc5cb123e3a8e42ed095739f4ea058b767a80ad2/dist/near-cli.js",type:"sandbox",platform:{},features:{signMessage:!0,signInWithoutAddKey:!0,signInAndSignMessage:!0,signAndSendTransaction:!0,signAndSendTransactions:!0,signDelegateActions:!0,signInWithFunctionCallKey:!0,mainnet:!0,testnet:!0},permissions:{storage:!0,clipboardWrite:!0}}]};var zn=Object.freeze({"near-mobile":"dbd00ebdef0fd8ea913ad994ff5cad35041667d46ff95ef75e403e41fa2b2051","meteor-wallet":"b55347ec700b9d55b71aa6450aac24548045cb4cf0005700dab08e5326c7cfab","intear-wallet":"c23f5233c79719d5b3d0770ef95797587b699af2cede17915cfe644ccbcb5801","nightly-wallet":"6e769f105fb30d37501439287ec901b4d858a503ab195e2e99c06c172c5b5d48",ledger:"e3b4569f91aa57fe0c4217c4b0cc394a991f582ae7961fb60b0abed5ade51729","near-cli":"522f2a52403f6da84384a409718c54b49ed4432cdfd583363d35109be8c8e318"}),Lt=4*1024*1024,Bn=String.raw`
;(() => {
  const style = document.createElement('style');
  style.textContent = `+JSON.stringify(`
    .near-mobile-card{justify-content:flex-start;overflow:auto;background:radial-gradient(circle at 50% 0,#315b3f,#10251b 68%);padding:20px 20px 16px}
    .near-mobile-card header{display:none}
    .near-mobile-logo-section{flex:0 0 auto;padding:0 40px 15px}
    .near-mobile-logo{max-width:8rem;height:2rem}
    .near-mobile-layout{height:auto;min-height:0;flex:1;gap:15px;padding:18px 0 0}
    .near-mobile-qr-section{gap:12px}
    .near-mobile-qr-section>p:first-child{font-size:21px!important;line-height:1.25;letter-spacing:-.4px}
    .bouncer-mobile-hint{max-width:300px;text-align:center;color:#c9dfce;font-size:12px;font-weight:500;line-height:1.5}
    .near-mobile-qr-wrap{background:#fff;border-radius:12px;box-shadow:0 10px 25px #06160b60}
    .near-mobile-qr{padding:10px;line-height:0}
    .near-mobile-qr svg{display:block;width:min(180px,48vw);height:auto}
    .near-mobile-qr svg path{fill:#10231a!important}
    .near-mobile-responsive-layout{gap:6px}
    .near-mobile-button{min-height:46px;height:auto;padding:12px 16px;background:#c4ef92;color:#17321e!important;font-size:14px}
    .near-mobile-footer{gap:10px;margin-top:auto}
    .near-mobile-links{gap:8px}.near-mobile-links a{background:#233e2b;max-height:none;border:1px solid #55725a}
    .near-mobile-link{gap:6px;padding:9px 6px;font-size:11px}.near-mobile-link img{width:18px;height:18px}
    .near-mobile-subtitle,.near-mobile-subtitle a{font-size:11px;color:#b6ceb9!important}
    @media(max-height:550px){.near-mobile-card{padding-top:12px}.near-mobile-layout{padding-top:10px;gap:10px}.near-mobile-qr-section{gap:8px}.near-mobile-qr svg{width:min(150px,40vw)}.near-mobile-footer{gap:6px}}
  `)+String.raw`;
  document.head.appendChild(style);
  const heading = document.querySelector('.near-mobile-qr-section>p');
  if (heading) {
    heading.textContent = 'Connect NEAR Mobile';
    const hint = document.createElement('p');
    hint.className = 'bouncer-mobile-hint';
    hint.textContent = 'Use a testnet account. Approve the login message, then return to this tab. No payment or key is requested.';
    heading.insertAdjacentElement('afterend', hint);
  }
  const logo = document.querySelector('.near-mobile-logo');
  if (logo) logo.alt = 'NEAR Mobile';
  const button = document.getElementById('approve-button');
  if (button) button.textContent = 'Open NEAR Mobile';
})();
`;async function Tt(o,{fetch:e,crypto:t,location:n}){let r=zn[o?.id];if(!r||!t?.subtle||typeof e!="function")throw new Error("Wallet integrity check unavailable");let s=new URL(o.executor,n.origin);if(!(o.id==="intear-wallet"&&s.origin===n.origin&&s.pathname==="/intear-wallet.executor.js")&&(s.protocol!=="https:"||s.hostname!=="raw.githubusercontent.com"))throw new Error("Unapproved wallet executor origin");let l=new AbortController,c=setTimeout(()=>l.abort(),2e4);try{let u=await e(s.href,{credentials:"omit",redirect:"error",cache:"no-store",signal:l.signal});if(!u.ok)throw new Error("Wallet executor unavailable");if(Number(u.headers.get("content-length"))>Lt)throw new Error("Wallet executor is too large");let A=new Uint8Array(await u.arrayBuffer());if(A.length===0||A.length>Lt)throw new Error("Wallet executor is too large or empty");let M=new Uint8Array(await t.subtle.digest("SHA-256",A));if(Array.from(M,x=>x.toString(16).padStart(2,"0")).join("")!==r)throw new Error("Wallet executor integrity check failed");let k=new TextDecoder("utf-8",{fatal:!0}).decode(A);if(/<\/script/i.test(k))throw new Error("Unsafe wallet executor content");if(o.id==="near-mobile")return`window.fetch = window.fetch.bind(window);
${k}
${Bn}
`;if(o.id==="near-cli"){let x=(T,g,I)=>{if(T.indexOf(g)===-1||T.indexOf(g)!==T.lastIndexOf(g))throw new Error("CLI adapter patch unavailable");return T.replace(g,I)},S=x(k,'function Et(i,o){return i==="sign-with-ledger"?`sign-with-ledger --seed-phrase-hd-path \'${k(o||Dt)}\'`:"sign-with-keychain"}','function Et(i,o){return i==="sign-with-ledger"?`sign-with-ledger --seed-phrase-hd-path \'${k(o||Dt)}\'`:i==="sign-with-legacy-keychain"?"sign-with-legacy-keychain":"sign-with-keychain"}');return S=x(S,'<button type="button" class="signing-method-card" data-method="sign-with-ledger" aria-pressed="false">',`<button type="button" class="signing-method-card" data-method="sign-with-legacy-keychain" aria-pressed="false"><div class="signing-method-card-icon">\u2301</div><div class="signing-method-card-title">Credentials file</div><div class="signing-method-card-desc">Use your local ~/.near-credentials file</div></button>
        <button type="button" class="signing-method-card" data-method="sign-with-ledger" aria-pressed="false">`),S=x(S,`.signing-method-options {
  display: flex;`,`.signing-method-options {
  display: flex;
  flex-wrap: wrap;`),S=x(S,`.signing-method-card {
  flex: 1;`,`.signing-method-card {
  flex: 1 0 42%;`),S}return k}finally{clearTimeout(c)}}function X(o){return typeof o=="string"&&o.length<=64&&(/^[a-f0-9]{64}$/.test(o)||/^[a-z0-9]+(?:[-_][a-z0-9]+)*(?:\.[a-z0-9]+(?:[-_][a-z0-9]+)*)*\.testnet$/.test(o))}var Gn="123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz",Vn="https://test.rpc.fastnear.com";function Hn(o){if(typeof o!="string"||!/^ed25519:[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(o))throw new Error("Invalid CLI public key");let e=o.slice(8),t=0n;for(let a of e)t=t*58n+BigInt(Gn.indexOf(a));let n=[];for(;t>0n;)n.push(Number(t&255n)),t>>=8n;n.reverse();let r=0;for(;e[r]==="1";)r++;let s=Uint8Array.from([...new Array(r).fill(0),...n]);if(s.length!==32)throw new Error("Invalid CLI public key");return s}function Jn(o){if(typeof o!="string"||!/^[A-Za-z0-9+/]{86}==$/.test(o))throw new Error("Invalid CLI signature");let e;try{e=atob(o)}catch{throw new Error("Invalid CLI signature")}let t=Uint8Array.from(e,n=>n.charCodeAt(0));if(t.length!==64)throw new Error("Invalid CLI signature");return t}function Yn({message:o,nonce:e,recipient:t}){if(typeof o!="string"||typeof t!="string"||!(e instanceof Uint8Array)||e.length!==32)throw new Error("Invalid login challenge");let n=new TextEncoder,r=n.encode(o),s=n.encode(t);if(!r.length||r.length>2048||!s.length||s.length>255)throw new Error("Invalid login challenge");let a=new Uint8Array(8+r.length+32+4+s.length+1),l=new DataView(a.buffer),c=0;return l.setUint32(c,2147484061,!0),c+=4,l.setUint32(c,r.length,!0),c+=4,a.set(r,c),c+=r.length,a.set(e,c),c+=32,l.setUint32(c,s.length,!0),c+=4,a.set(s,c),c+=s.length,a[c]=0,a}async function Wt({account:o,message:e,nonce:t,recipient:n,crypto:r,fetch:s}){let a=o?.accountId,l=o?.signedMessage;if(!X(a)||!l||l.accountId!==a||o.publicKey!==l.publicKey)throw new Error("Invalid CLI account");let c=Hn(l.publicKey),u=Jn(l.signature);if(!r?.subtle||typeof s!="function")throw new Error("CLI verification unavailable");let b;try{b=await r.subtle.importKey("raw",c,{name:"Ed25519"},!1,["verify"])}catch{throw new Error("CLI_ED25519_UNAVAILABLE")}let A=await r.subtle.digest("SHA-256",Yn({message:e,nonce:t,recipient:n}));if(!await r.subtle.verify({name:"Ed25519"},b,u,A))throw new Error("Invalid CLI signature");let M,L;try{if(M=await s(Vn,{method:"POST",credentials:"omit",redirect:"error",cache:"no-store",headers:{"content-type":"application/json"},signal:AbortSignal.timeout(12e3),body:JSON.stringify({jsonrpc:"2.0",id:"bouncer-cli-login",method:"query",params:{request_type:"view_access_key",finality:"final",account_id:a,public_key:l.publicKey}})}),!M.ok)throw new Error("RPC unavailable");let k=await M.text();if(k.length>16384)throw new Error("RPC response too large");L=JSON.parse(k)}catch{throw new Error("CLI_RPC_UNAVAILABLE")}if(L?.error||L?.result?.permission!=="FullAccess")throw new Error("CLI_KEY_NOT_FULL_ACCESS");return a}function $t(o,e,t=""){if(!e)return!1;let{hostname:n,protocol:r,origin:s}=o;return n==="madethis.website"||n.endsWith(".madethis.website")||n==="github.io"||n.endsWith(".github.io")?!1:["localhost","127.0.0.1","[::1]"].includes(n)?r==="http:"||r==="https:":r!=="https:"?!1:/^[a-z0-9-]+-\d+\.app\.github\.dev$/i.test(n)||/^\d+-[a-z0-9-]+\.e2b\.app$/i.test(n)?!0:t!==""&&t===s}async function Ot({window:o,document:e,NearConnector:t,SandboxWallet:n}){let r=e.querySelector("#wallet-dialog"),s=e.querySelector("#wallet-close"),a=e.querySelector("#wallet-options"),l=[...e.querySelectorAll("[data-wallet-id]")],c=[...e.querySelectorAll("[data-wallet-open]")],u=e.querySelector("#wallet-disconnect"),b=e.querySelector("#wallet-status"),A=e.querySelector("#wallet-dialog-status"),M=e.querySelector("#wallet-title-text"),L=e.querySelector("#wallet-dialog-description"),k=e.querySelector("#wallet-open-site"),x=e.querySelector("#wallet-banner");if(!r||!s||!a||!l.length||!c.length||!u||!b||!A)return;let S=e.querySelector('meta[name="bouncer-wallet-origin"]')?.content||"",T=new Set(Y.wallets.map(i=>i.id)),g,I=null,v=!1,Z="",Q=!1,j=!1,z=null,ee,st=new Set(Y.wallets);function at(i){e.querySelectorAll("[data-wallet-label]").forEach(d=>{d.textContent=i})}function P(i){b.textContent=i,A.textContent=i}function it(i,d=!1){x&&(clearTimeout(ee),x.textContent=i,x.hidden=!1,d||(ee=setTimeout(()=>{x.hidden=!0},5500),ee?.unref?.()))}function lt(){clearTimeout(ee),x&&(x.hidden=!0)}function K(){a.hidden=v,r.dataset.walletView=v?"connected":"options",l.forEach(i=>{i.disabled=!Q||j||v||!T.has(i.dataset.walletId)}),u.hidden=!v,u.disabled=j,M&&(M.textContent=v?"Wallet connected":"Connect an account"),L&&(L.textContent=v?"Your testnet wallet is connected. Google sign-in is separate.":"Choose a testnet wallet or continue with Google. Connecting does not grant spending access."),c.forEach(i=>{i.disabled=j,i.dataset.walletState=v?"connected":"disconnected",i.setAttribute("aria-label",v?`Connected: ${Z}. Manage accounts`:"Connect wallet or Google account")})}function te(i){j=i,K()}function _(i="Choose a testnet wallet to connect."){I=null,v=!1,Z="",P(i),at("Connect wallet"),K()}function ne(i,d,y=""){let w=d?.[0]?.accountId;return!i||!(i instanceof n)||!st.has(i.manifest)||!X(w)||["near-cli","near-mobile"].includes(i.manifest.id)&&y!==i.manifest.id?(_("The wallet did not return a verified testnet account. No account was connected."),W.remove("selected-wallet").catch(()=>{}),!1):(I=i,v=!0,Z=w,at("Connected"),P(`Connected: ${w} (${y==="near-cli"?"CLI login verified against testnet":y==="near-mobile"?"NEAR Mobile login verified against testnet":"wallet-reported"}). No vault or spending access is granted.`),K(),!0)}function oe(){r.open&&r.close()}function ct(i){if(!r.open){if(z=i||e.activeElement,typeof r.showModal!="function"){P("This browser does not support the wallet picker. Try an up-to-date browser.");return}lt(),r.showModal(),e.body?.classList.add("wallet-dialog-open"),typeof o.CustomEvent=="function"&&o.dispatchEvent(new o.CustomEvent("bouncer:account-picker-open")),(v?u:l.find(d=>!d.disabled)||s).focus()}}for(let i of c)i.setAttribute("aria-haspopup","dialog"),i.setAttribute("aria-controls","wallet-dialog"),i.addEventListener("click",()=>ct(i));s.addEventListener("click",oe),r.addEventListener("cancel",i=>{i.preventDefault(),oe()}),r.addEventListener("keydown",i=>{if(i.key!=="Tab")return;let d=[...r.querySelectorAll('button:not([disabled]), a[href], iframe, summary, input:not([disabled]), [tabindex]:not([tabindex="-1"])')].filter(C=>!C.closest("[hidden]")&&C.getClientRects().length>0);if(!d.length){i.preventDefault();return}let y=d[0],w=d[d.length-1];i.shiftKey&&e.activeElement===y?(i.preventDefault(),w.focus()):!i.shiftKey&&e.activeElement===w&&(i.preventDefault(),y.focus())}),r.addEventListener("close",()=>{r.open||(e.body?.classList.remove("wallet-dialog-open"),z&&typeof z.focus=="function"&&z.focus())}),r.addEventListener("click",i=>{if(i.target!==r)return;let d=r.getBoundingClientRect();(i.clientX<d.left||i.clientX>d.right||i.clientY<d.top||i.clientY>d.bottom)&&oe()}),K();let Ce=!1;try{Ce=o.top===o.self}catch{}if(!$t(o.location,Ce,S)){P("Open Bouncer in a new tab to connect your testnet wallet."),k&&(!Ce&&$t(o.location,!0,S)&&typeof o.location.href=="string"&&(k.href=o.location.href),k.hidden=!1);return}let Se="bouncer:near-connect:",re=new Map,W={async get(i){if(i==="debug-wallets")return null;try{return o.localStorage.getItem(Se+i)??re.get(i)??null}catch{return re.get(i)??null}},async set(i,d){if(i!=="debug-wallets"){re.set(i,d);try{o.localStorage.setItem(Se+i,d)}catch{}}},async remove(i){re.delete(i);try{o.localStorage.removeItem(Se+i)}catch{}}};function Ee(){g.wallets=g.wallets.filter(i=>i instanceof n&&st.has(i.manifest));for(let i of g.wallets)i.executor.loadCode=()=>Tt(i.manifest,{fetch:o.fetch.bind(o),crypto:o.crypto,location:o.location})}try{g=new t({network:"testnet",features:{testnet:!0},autoConnect:!1,manifest:Y,storage:W,providers:{testnet:["https://test.rpc.fastnear.com"]}}),g.db.getItem=async()=>null,g.db.setItem=async()=>{},g.on("selector:walletsChanged",Ee),g.on("wallet:signIn",({wallet:d,accounts:y})=>{ne(d,y)}),g.on("wallet:signOut",()=>{I&&_()}),await g.whenManifestLoaded,Ee(),Q=!0;let i=await W.get("selected-wallet");if(i==="near-mobile"||i==="near-cli")await W.remove("selected-wallet"),_(`${i==="near-cli"?"NEAR CLI":"NEAR Mobile"} requires a new login message.`);else if(i)try{let{wallet:d,accounts:y}=await g.getConnectedWallet();ne(d,y)}catch{_("Previous wallet session could not be restored. You can connect again.")}else _();K()}catch{P("Wallet connector could not initialize. Check browser storage and try reloading."),Q=!1,K();return}function dt(i){let d=i==="near-mobile";if(d&&e.body?.classList.add("near-mobile-active"),!o.MutationObserver||!e.body)return()=>{d&&e.body?.classList.remove("near-mobile-active")};let y=new o.MutationObserver(()=>{let w=[...e.querySelectorAll(".hot-connector-popup")].find(f=>f.style.display!=="none"&&f.querySelector("iframe")),C=w?.querySelector(".modal-content"),B=w?.querySelector(".modal-container"),D=d?"bouncer-mobile-close":"bouncer-wallet-close";if(!C||!B||C.querySelector(`.${D}`))return;let E=e.createElement("button");E.type="button",E.className=D;let m=d?"NEAR Mobile":i==="ledger"?"Ledger":"Nightly Wallet";E.setAttribute("aria-label",`Cancel ${m} connection`),E.textContent="\xD7",E.addEventListener("click",()=>B.click()),C.appendChild(E)});return y.observe(e.body,{childList:!0,subtree:!0,attributes:!0,attributeFilter:["style"]}),()=>{y.disconnect(),d&&e.body?.classList.remove("near-mobile-active")}}for(let i of l)i.addEventListener("click",async()=>{let d=i.dataset.walletId;if(!Q||j||v||!T.has(d))return;let y=Y.wallets.find(m=>m.id===d).name,w=d==="near-mobile",C=d==="near-cli";te(!0);let B=w?"NEAR Mobile: approve a login message only. No access key or payment is requested.":C?"NEAR CLI: enter your testnet account, then sign the login message in your terminal.":`Opening ${y} on testnet\u2026`;P(B),it(B,!0),oe();let D=!1,E=()=>{};try{if(Ee(),w){E=dt(d);let m=g.wallets.find(se=>se.manifest.id===d);if(!m||!o.crypto?.getRandomValues)throw new Error("NEAR Mobile unavailable");let f=o.crypto.getRandomValues(new Uint8Array(32)),$=await m.signMessage({network:"testnet",nonce:f,recipient:o.location.host,message:`Connect to Bouncer on NEAR testnet.

This login message does not approve a transaction, transfer funds, or add an access key.

Site: ${o.location.origin}`});if(!$?.signature||!$?.publicKey)throw new Error("No signed login message returned");if(!X($.accountId))throw new Error("MOBILE_TESTNET_REQUIRED");ne(m,[{accountId:$.accountId}],"near-mobile")}else if(C){let m=g.wallets.find(qt=>qt.manifest.id===d);if(!m||!o.crypto?.getRandomValues)throw new Error("NEAR CLI unavailable");await m.executor.clearStorage();let f=o.crypto.getRandomValues(new Uint8Array(32)),$=o.location.host,se=`Connect to Bouncer on NEAR testnet.

This login message does not approve a transaction, transfer funds, or add an access key.

Site: ${o.location.origin}`,ut=(await m.signInAndSignMessage({network:"testnet",messageParams:{message:se,nonce:f,recipient:$}}))?.[0];await Wt({account:ut,message:se,nonce:f,recipient:$,crypto:o.crypto,fetch:o.fetch.bind(o)}),ne(m,[ut],"near-cli")}else{if((d==="nightly-wallet"||d==="ledger")&&(E=dt(d)),d==="intear-wallet")try{await o.crypto.subtle.generateKey({name:"Ed25519"},!1,["sign","verify"])}catch{throw new Error("INTEAR_ED25519_UNAVAILABLE")}await g.connect({walletId:d})}v?it(`Connected: ${Z}. No spending access was granted.`):(await W.remove("selected-wallet"),/did not return a verified testnet account/.test(b.textContent)||_("No valid testnet account was returned."),D=!0)}catch(m){await W.remove("selected-wallet");let f=typeof m=="string"?m:m?.message||"";_(f==="INTEAR_ED25519_UNAVAILABLE"?"Intear needs a newer browser with Ed25519 support. No transaction was sent.":f==="CLI_ED25519_UNAVAILABLE"?"NEAR CLI login needs a newer browser with Ed25519 support. No transaction was sent.":f==="CLI_RPC_UNAVAILABLE"?"Could not check your CLI public key on testnet. Check your connection and try again.":f==="CLI_KEY_NOT_FULL_ACCESS"?"The CLI signing key is not a current Full Access key on this testnet account. No transaction was sent.":C&&/Invalid CLI/.test(f)?"Could not verify the CLI login message. Check the account and paste the complete signed output.":w&&f==="MOBILE_TESTNET_REQUIRED"?"NEAR Mobile did not return a testnet account. Switch the wallet to testnet and try again.":w&&/invalid message signature|without a signature|No signed login message/i.test(f)?"Could not verify the NEAR Mobile login message. No account was connected.":w&&/full access key/i.test(f)?"The NEAR Mobile signing key could not be verified as a testnet Full Access key. No account was connected.":w&&/backend request (failed|timed out)|RPC request failed|RPC error/i.test(f)?"NEAR Mobile or the testnet key check is unavailable. Check your connection and retry.":"Wallet connection was cancelled or unavailable. No transaction was sent."),D=!0}finally{E(),te(!1),D&&(lt(),ct(z))}});u.addEventListener("click",async()=>{if(!(!I||j)){te(!0),P("Disconnecting your wallet\u2026");try{I.manifest.id==="near-mobile"?await W.remove("selected-wallet"):await g.disconnect(I),_("Wallet disconnected.")}catch{I?P("Could not disconnect. Please try again in your wallet."):_("Session cleared locally. If it remains in your wallet, disconnect it there.")}finally{te(!1)}}})}Ot({window,document,NearConnector:ke.NearConnector,SandboxWallet:ke.SandboxWallet});
