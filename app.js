let state={
rounds:[{
id:"R1",
name:"Round 1",
cases:[
{status:"pass"},
{status:"fail"},
{status:"pending"}
]
}],
current:"R1"
};

function getRound(){
return state.rounds.find(r=>r.id===state.current);
}

function getSummary(r){
let total=r.cases.length;
let pass=r.cases.filter(c=>c.status==="pass").length;
let fail=r.cases.filter(c=>c.status==="fail").length;
let pending=total-pass-fail;
let rate= total?Math.round(pass/total*100):0;
return{total,pass,fail,pending,rate};
}

function getBadge(rate){
if(rate>=80) return "🟢 Good";
if(rate>=50) return "🟡 Risk";
return "🔴 Critical";
}

function render(){
let r=getRound();
let s=getSummary(r);

let el=document.getElementById("summary");
el.classList.add("fade");

setTimeout(()=>{
el.innerHTML=`
<div class="summary-cards">
<div class="card"><div class="num">${s.total}</div>Total</div>
<div class="card pass"><div class="num">${s.pass}</div>Pass</div>
<div class="card fail"><div class="num">${s.fail}</div>Fail</div>
<div class="card pending"><div class="num">${s.pending}</div>Pending</div>
<div class="card rate"><div class="num">${s.rate}%</div>Rate</div>
</div>`;
el.classList.remove("fade");

document.getElementById("badge").innerText=getBadge(s.rate);

},150);
}

function changeRound(){
state.current=document.getElementById("roundSelect").value;
render();
}

function exportHTML(){
let html=document.documentElement.outerHTML;
download(html,"summary.html","text/html");
}

function exportPNG(){
let canvas=document.createElement("canvas");
canvas.width=800;canvas.height=400;
let ctx=canvas.getContext("2d");
ctx.fillStyle="#fff";
ctx.fillRect(0,0,800,400);
ctx.fillStyle="#000";
ctx.fillText("QA Summary",50,50);
download(canvas.toDataURL(),"summary.png");
}

function exportPDF(){
let content="QA Summary";
download(content,"summary.pdf","application/pdf");
}

function download(content,name,type){
let blob= type==="application/pdf"?
new Blob([content],{type}):
(typeof content==="string"?
new Blob([content],{type}):
dataURLtoBlob(content));

let a=document.createElement("a");
a.href=URL.createObjectURL(blob);
a.download=name;
a.click();
}

function dataURLtoBlob(dataurl){
let arr=dataurl.split(","),mime=arr[0].match(/:(.*?);/)[1];
let bstr=atob(arr[1]),n=bstr.length,u8arr=new Uint8Array(n);
while(n--){u8arr[n]=bstr.charCodeAt(n);}
return new Blob([u8arr],{type:mime});
}

function init(){
let sel=document.getElementById("roundSelect");
sel.innerHTML=state.rounds.map(r=>`<option value="${r.id}">${r.name}</option>`).join("");
render();
}

init();
