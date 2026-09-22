"""Offline shell regression checks using macOS JavaScriptCore and synthetic data.

Run from any directory: python3 tests/check_site.py
The minimal DOM checks behavior, not browser layout or live connectivity.
"""
import ctypes, pathlib
from html.parser import HTMLParser
root=pathlib.Path(__file__).resolve().parents[1]
class Parser(HTMLParser):
 def __init__(self): super().__init__(); self.ids=[]
 def handle_starttag(self, tag, attrs):
  a=dict(attrs)
  if 'id' in a: self.ids.append(a['id'])
p=Parser(); p.feed((root/'index.html').read_text()); assert len(p.ids)==len(set(p.ids))
lib=ctypes.CDLL('/System/Library/Frameworks/JavaScriptCore.framework/JavaScriptCore')
ptr=ctypes.c_void_p
lib.JSGlobalContextCreate.argtypes=[ptr];lib.JSGlobalContextCreate.restype=ptr
lib.JSStringCreateWithUTF8CString.argtypes=[ctypes.c_char_p];lib.JSStringCreateWithUTF8CString.restype=ptr
lib.JSEvaluateScript.argtypes=[ptr,ptr,ptr,ptr,ctypes.c_int,ctypes.POINTER(ptr)];lib.JSEvaluateScript.restype=ptr
lib.JSValueToStringCopy.argtypes=[ptr,ptr,ctypes.POINTER(ptr)];lib.JSValueToStringCopy.restype=ptr
lib.JSStringGetUTF8CString.argtypes=[ptr,ctypes.c_char_p,ctypes.c_size_t]
ctx=lib.JSGlobalContextCreate(None)
def evaluate(source):
 s=lib.JSStringCreateWithUTF8CString(source.encode());err=ptr();v=lib.JSEvaluateScript(ctx,s,None,None,1,ctypes.byref(err))
 out=lib.JSValueToStringCopy(ctx,err.value or v,None);buf=ctypes.create_string_buffer(16000);lib.JSStringGetUTF8CString(out,buf,len(buf))
 if err.value: raise Exception(buf.value.decode())
 return buf.value.decode()
setup='''
class Element {
 constructor(){this.children=[];this.value="";this.textContent="";this.handlers={};}
 append(...items){this.children.push(...items)}
 replaceChildren(...items){this.children=items}
 focus(){} reset(){document.getElementById("pin").value="";document.getElementById("username").value=""}
 addEventListener(name,fn){this.handlers[name]=fn}
}
const elements={};
const document={getElementById(id){return elements[id]||(elements[id]=new Element())},querySelectorAll(){return []},createElement(){return new Element()},createDocumentFragment(){return new Element()}};
const storage={};const localStorage={getItem(k){return storage[k]},setItem(k,v){storage[k]=v},removeItem(k){delete storage[k]}};
const window={addEventListener(){}};
const navigator={userAgent:"iPhone",platform:"iPhone"};
function assert(v,m){if(!v)throw Error(m)}
'''
print(evaluate(setup+(root/'app.js').read_text()+'\n"JavaScript parsed and initialized"'))
tests='''
var result="pending";
(async()=>{
 await navigate("rules"); assert(!elements["login-view"].hidden,"guest gate");
 assert(elements.content.children.length===0,"guest content");
 user={username:"test",is_admin:false};saveToken("temporary-test-token");
 await navigate("admin");assert(!elements["menu-view"].hidden,"admin gate");
 user.is_admin=true;await navigate("admin");assert(elements.content.children.length===6,"admin sections");
 renderContent("rules",{rules:[{body:"<img>"}]});
 assert(elements.content.children[0].children[0].children[1].textContent==="<img>","text only");
 renderContent("schedule",{game_schedule:[{name:"test",day:"test",reservation_phone:"javascript:bad"}]});
 assert(elements.content.children[0].children[0].children[2].href===undefined,"invalid SMS target");
 renderContent("schedule",{game_schedule:[{name:"A & B",day:"a day",reservation_phone:"+"+"1".repeat(11)}]});
 const sms=elements.content.children[0].children[0].children[2].href;
 assert(decodeURIComponent(sms.split("body=")[1])==="I would like to reserve a seat for the A & B game on a day.","SMS body");
 assert(sms.includes("&body="),"iPhone separator");
 renderContent("schedule",{game_schedule:[]});assert(elements.content.children[0].children.length===1,"empty state");
 let resolve;api=()=>new Promise(r=>resolve=r);
 const pending=navigate("rules");await navigate("menu");resolve({rules:[{body:"stale"}]});await pending;
 assert(elements.content.children.length===0,"stale response");
 api=async()=>{const e=Error("expired");e.status=401;throw e};
 await navigate("rules");assert(user===null&&!token&&!storage[SESSION_KEY],"expired session cleared");
 assert(elements.content.children.length===0,"expired content cleared");
 // Synthetic data only: no live credentials or protected club content.
 const profile={username:"test-member",display_name:"Test Member",is_admin:true};
 const bootstrap={user:profile,rules:[{id:1,body:"<test-body>",updated_at:"test"}],game_schedule:[],
   bonus_hands:[{id:"test",hand_name:"Test heading",payout_text:"Test payout",description:"Test description",sort_order:1,is_active:true,created_at:"test",updated_at:"test"}],
   settings:{reservation_phone_1:"",reservation_phone_2:""}};
 const calls=[];
 api=async(action,fields,session)=>{
   calls.push({action,fields,session});
   if(action==="login")return {session_token:"synthetic-session",...profile,expires_at:"test"};
   if(action==="bootstrap")return bootstrap;
   if(action==="logout")return {};
   throw Error("Unexpected API action: "+action);
 };
 $("username").value="test-member";$("pin").value=String(10 ** 3);
 await $("login-form").handlers.submit({preventDefault(){}});
 assert(token==="synthetic-session"&&storage[SESSION_KEY]===token,"top-level login session_token");
 assert(user.username===profile.username&&user.display_name===profile.display_name,"top-level profile");
 assert(!$("admin-button").hidden,"top-level admin flag");
 assert(calls.length===1&&calls[0].action==="login"&&calls[0].session==="","login before protected fetch");
 assert($("pin").value==="","PIN cleared");
 assert(Object.keys(storage).length===1,"only session persisted");
 await navigate("rules");
 assert(calls[1].action==="bootstrap","bootstrap action");
 assert(elements.content.children[0].children[0].children[1].textContent==="<test-body>","rules array body");
 renderContent("rules",{rules:[{body:"first"},{body:"second"}]});
 assert(elements.content.children[0].children.length===1,"only first rules row");
 renderContent("rules",{rules:[]});assert(elements.content.children[0].children.length===1,"empty rules");
 await navigate("schedule");assert(elements.content.children[0].children[0].children[0].textContent==="Nothing posted yet","game_schedule empty");
 await navigate("bonus");
 const bonus=elements.content.children[0].children[0];
 assert(bonus.children[0].textContent==="Test heading","hand_name");
 assert(bonus.children[1].textContent==="Test payout\\nTest description","payout and description");
 renderContent("bonus",{bonus_hands:[{hand_name:"later",sort_order:2,is_active:true},{hand_name:"hidden",sort_order:0,is_active:false},{hand_name:"earlier",sort_order:1,is_active:true}]});
 assert(elements.content.children[0].children.length===2&&elements.content.children[0].children[0].children[0].textContent==="earlier","active hands sorted");
 const game={name:"test-game",day:"test-day"};
 renderContent("schedule",{game_schedule:[game],settings:bootstrap.settings});
 assert(!elements.content.children[0].children[0].children[2].href,"empty settings disable SMS");
 const phones={reservation_phone_1:"+"+"1".repeat(11),reservation_phone_2:"+"+"2".repeat(11)};
 renderContent("schedule",{game_schedule:[game],settings:phones});
 assert(elements.content.children[0].children[0].children.length===4,"both settings contacts");
 for(const [index,phone] of Object.values(phones).entries())assert(elements.content.children[0].children[0].children[index+2].href.startsWith("sms:"+phone+"&body="),"settings SMS target");
 user=null;await initialize();
 assert(calls[calls.length-1].action==="bootstrap"&&user.username===profile.username,"restore via bootstrap");
 await $("logout").handlers.click();
 assert(user===null&&!token&&!storage[SESSION_KEY]&&elements.content.children.length===0,"logout clears session and content");
 assert(calls[calls.length-1].action==="logout"&&calls[calls.length-1].session==="synthetic-session","logout revokes returned token");
 api=async()=>({token:"wrong-field",...profile});
 $("username").value="test-member";$("pin").value=String(10 ** 3);
 await $("login-form").handlers.submit({preventDefault(){}});
 assert(!token&&!user,"legacy token field rejected");
 result="PASS: live response shapes, login, bootstrap, restore, rules, bonus hands, settings SMS, logout; guest/admin gates, text rendering, invalid SMS, empty content, stale responses, session expiry";
})().catch(e=>result="FAIL: "+e.message);
'''
evaluate(tests)
result=evaluate('result');print(result);assert result.startswith('PASS')
print('PASS: unique HTML IDs')
