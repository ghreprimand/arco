import readline from 'node:readline';
const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC';
for await (const line of readline.createInterface({input:process.stdin})) {
 const request=JSON.parse(line); if(request.id===undefined) continue;
 const result=request.method==='initialize'?{protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}}:
 request.method==='tools/list'?{tools:[
 {name:'read_picture',description:'Read a fixture image',inputSchema:{type:'object',properties:{label:{type:'string'}},required:['label']},annotations:{readOnlyHint:true}},
 {name:'write_picture',inputSchema:{type:'object',properties:{}},annotations:{readOnlyHint:false}},
 {name:'disabled_picture',inputSchema:{type:'object',properties:{}}}
 ]}:{content:[{type:'text',text:'fixture picture'},{type:'image',mimeType:'image/png',data:png}]};
 process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,result})+'\n');
}
