// Run: node --experimental-strip-types lib/vision/humanCheck.test.mts
import assert from 'node:assert/strict'
import { classifyFrame, HumanGate } from './humanCheck.ts'
const c = classifyFrame
assert.equal(c({faces:[0.9],objects:[]}).verdict,'human')
assert.equal(c({faces:[],objects:[{label:'person',score:0.8}]}).verdict,'human')
assert.deepEqual(c({faces:[],objects:[{label:'dog',score:0.9}]}),{verdict:'animal',animal:'dog'})
assert.equal(c({faces:[0.7],objects:[{label:'dog',score:0.9}]}).verdict,'animal')
assert.equal(c({faces:[0.3],objects:[{label:'cat',score:0.8}]}).verdict,'animal')
assert.equal(c({faces:[],objects:[{label:'person',score:0.6},{label:'dog',score:0.9}]}).verdict,'human') // person holding a dog
assert.equal(c({faces:[],objects:[{label:'chair',score:0.9}]}).verdict,'nobody')
assert.equal(c({faces:[0.2],objects:[]}).verdict,'nobody')
const g = new HumanGate(); let t=0
for (let i=0;i<3;i++) g.push('human',undefined,t+=250); assert.equal(g.state,'checking')
g.push('human',undefined,t+=250); assert.equal(g.state,'human')
g.push('nobody',undefined,t+=250); assert.equal(g.state,'human') // brief dropout tolerated
g.push('nobody',undefined,t+=4000); assert.equal(g.state,'nobody')
for (let i=0;i<5;i++) g.push('animal','dog',t+=250); assert.equal(g.state,'nobody')
g.push('animal','dog',t+=250); assert.equal(g.state,'animal'); assert.equal(g.animal,'dog')
for (let i=0;i<4;i++) g.push('human',undefined,t+=250); assert.equal(g.state,'human')
const h = new HumanGate(); for (let i=0;i<11;i++) h.push('nobody',undefined,i*250); assert.equal(h.state,'checking'); h.push('nobody',undefined,3000); assert.equal(h.state,'nobody')
console.log('ok')
