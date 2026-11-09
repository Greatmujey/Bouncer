/**
 * Planning ONLY for an owner-controlled V14 catalog. A model chooses one of
 * two bounded compute tasks and its parameters; it never supplies accounts,
 * routes, policies, prices, storage IDs, keys or transactions. The returned
 * manifest still needs explicit owner review and the normal runner/service.
 * A generated plan is not evidence of a live run or correct interpretation.
 */
import { readBoundedJson } from '../shared/bounded-json.mjs';
import { validateNativeMission } from './native-mission.mjs';
import { validateObjective } from './goal-planner.mjs';
import { marketQuantity } from './market-summary.mjs';

const plain = x => x !== null && typeof x === 'object' && !Array.isArray(x) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(x));
const exact = (x, keys) => {
  if (!plain(x)) return false;
  const properties = Object.getOwnPropertyDescriptors(x);
  return Object.keys(properties).length === keys.length && keys.every(k => Object.hasOwn(properties[k] ?? {}, 'value'));
};
const number = (value, low, high) => Number.isSafeInteger(value) && value >= low && value <= high;
function freeze(x) {
  if (x && typeof x === 'object' && !Object.isFrozen(x)) { Object.freeze(x); for (const value of Object.values(x)) freeze(value); }
  return x;
}
function fullMission(mission, expected) {
  const checked = validateNativeMission(mission);
  if (checked.goals.map(x => x.kind).join(',') !== expected ||
      !['compute','api','storage'].every(r => checked.required_resources.includes(r))) {
    throw new Error('planner template must contain the supported three-resource sequence');
  }
  const storage = checked.goals[2].goal;
  const expectedSources = checked.goals.slice(0,2).map(item => item.goal.id);
  if (!plain(storage.value) || !Array.isArray(storage.value.from_goal_ids) ||
      JSON.stringify(storage.value.from_goal_ids) !== JSON.stringify(expectedSources)) {
    throw new Error('planner template must publicly record both earlier verified results');
  }
  return checked;
}

/** Snapshot authority and limits before asking any model. */
export function validateNativePlanningCatalog(raw) {
  if (!exact(raw, ['version','market','random']) || raw.version !== 1 ||
      !exact(raw.market, ['mission','max_quantity']) || !exact(raw.random, ['mission','min','max','max_span']) ||
      !number(raw.market.max_quantity,1,1000) || !number(raw.random.min,0,1_000_000_000) ||
      !number(raw.random.max,raw.random.min,1_000_000_000) || !number(raw.random.max_span,0,1_000_000)) {
    throw new Error('invalid owner-controlled native planning catalog');
  }
  const market = fullMission(raw.market.mission, 'oracle,market,storage');
  const random = fullMission(raw.random.mission, 'random,oracle,storage');
  const marketGoal = market.goals[1].goal, randomGoal = random.goals[0].goal;
  if (market.owner_account_id !== random.owner_account_id || market.contract_id !== random.contract_id ||
      market.id === random.id || market.goals[2].goal.contract_code_hash !== random.goals[2].goal.contract_code_hash ||
      marketGoal.input.quantity > raw.market.max_quantity || randomGoal.input.min < raw.random.min ||
      randomGoal.input.max > raw.random.max || randomGoal.input.max - randomGoal.input.min > raw.random.max_span) {
    throw new Error('native planning templates or input limits do not agree');
  }
  return freeze({version:1,market:{mission:market,max_quantity:raw.market.max_quantity},
    random:{mission:random,min:raw.random.min,max:raw.random.max,max_span:raw.random.max_span}});
}

/** Untrusted output can only select the compute type and bounded inputs. */
export function nativeMissionFromProposal(raw, rawCatalog) {
  const catalog = validateNativePlanningCatalog(rawCatalog);
  let mission;
  if (exact(raw,['kind','quantity']) && raw.kind === 'market') {
    const quantity = marketQuantity(raw.quantity);
    if (quantity > catalog.market.max_quantity) throw new Error('model quantity exceeds the owner limit');
    mission = structuredClone(catalog.market.mission);
    mission.goals[1].goal.input.quantity = quantity;
  } else if (exact(raw,['kind','min','max']) && raw.kind === 'random') {
    if (!number(raw.min,catalog.random.min,catalog.random.max) || !number(raw.max,raw.min,catalog.random.max) ||
        raw.max - raw.min > catalog.random.max_span) throw new Error('model random range exceeds the owner limit');
    mission = structuredClone(catalog.random.mission);
    mission.goals[0].goal.input = {min:raw.min,max:raw.max};
  } else throw new Error('unsupported or unauthorized native model proposal');
  return validateNativeMission(mission);
}

/** The model sees the objective and general task shapes, never the catalog. */
export async function planNativeObjective({objective, catalog: raw, modelClient} = {}) {
  const catalog = validateNativePlanningCatalog(raw);
  validateObjective(objective);
  if (typeof modelClient !== 'function') throw new Error('a native model client is required');
  const proposal = await modelClient({objective, choices:['market','random']});
  return nativeMissionFromProposal(proposal, catalog);
}

const SCHEMA = {type:'object',additionalProperties:false,required:['task'],properties:{task:{anyOf:[
  {type:'object',additionalProperties:false,required:['kind','quantity'],properties:{kind:{type:'string',enum:['market']},quantity:{type:'integer',minimum:1,maximum:1000}}},
  {type:'object',additionalProperties:false,required:['kind','min','max'],properties:{kind:{type:'string',enum:['random']},min:{type:'integer',minimum:0,maximum:1000000000},max:{type:'integer',minimum:0,maximum:1000000000}}},
]}}};
/** Optional OpenAI-compatible model endpoint. HTTPS is required except for a
 * local operator-run model. Redirects, refusals and incomplete plans fail. */
export function createNativeModelClient({endpoint,model,apiKey,fetchImpl=globalThis.fetch,timeoutMs=120_000} = {}) {
  let url; try { url=new URL(endpoint); } catch { throw new Error('a valid native model endpoint is required'); }
  const loopback=['localhost','127.0.0.1','[::1]'].includes(url.hostname);
  if ((url.protocol!=='https:' && !(url.protocol==='http:' && loopback)) || url.username || url.password || url.search || url.hash ||
      !url.pathname || url.pathname==='/' || typeof model!=='string' || !model.trim() || Buffer.byteLength(model)>128 ||
      (apiKey!==undefined && (typeof apiKey!=='string'||!apiKey||/[\r\n]/.test(apiKey))) ||
      typeof fetchImpl!=='function' || !number(timeoutMs,1,300_000)) throw new Error('invalid native model configuration');
  return async ({objective,choices}={}) => {
    validateObjective(objective);
    if (!Array.isArray(choices) || JSON.stringify(choices)!==JSON.stringify(['market','random'])) throw new Error('invalid native task choices');
    const headers={'content-type':'application/json'}; if(apiKey)headers.authorization=`Bearer ${apiKey}`;
    let response;
    try {
      response=await fetchImpl(url,{method:'POST',headers,redirect:'error',signal:AbortSignal.timeout(timeoutMs),
        body:JSON.stringify({model,temperature:0,max_tokens:300,stream:false,messages:[
          {role:'system',content:'Choose the requested bounded testnet compute task. market estimates USD value of a whole-number NEAR quantity using a public NEAR price; random chooses a random integer in a requested range. Return only the specified JSON. Do not invent or include accounts, URLs, prices, policies, keys or commands.'},
          {role:'user',content:objective}],response_format:{type:'json_schema',json_schema:{name:'bouncer_native_task',strict:true,schema:SCHEMA}}})});
    } catch { throw new Error('native model request failed or timed out'); }
    if (!response.ok) throw new Error(`native model request failed (HTTP ${response.status})`);
    let envelope; try { envelope=await readBoundedJson(response,{maxBytes:64*1024,label:'model'}); }
    catch { throw new Error('native model returned an invalid or oversized response'); }
    const message=envelope?.choices?.[0]?.message;
    if (!Array.isArray(envelope?.choices)||envelope.choices.length!==1||envelope.choices[0]?.finish_reason!=='stop'||
        !plain(message)||message.role!=='assistant'||typeof message.content!=='string'||message.refusal||message.tool_calls) {
      throw new Error('native model response was incomplete or ambiguous');
    }
    let parsed; try { parsed=JSON.parse(message.content); } catch { throw new Error('native model plan is not valid JSON'); }
    if (!exact(parsed,['task'])) throw new Error('native model plan has unexpected fields');
    return parsed.task;
  };
}
