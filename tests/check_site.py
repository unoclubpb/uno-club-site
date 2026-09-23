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
html=(root/'index.html').read_text(); p=Parser(); p.feed(html); assert len(p.ids)==len(set(p.ids))
assert 'Welcome to The Uno Club' not in html and 'Welcome to' in html
assert 'MEMBER INFORMATION' not in html
assert html.index('data-page="schedule"') < html.index('data-page="rules"') < html.index('data-page="bonus"') < html.index('data-page="admin"')
css=(root/'styles.css').read_text(); assert 'position: fixed' in css and 'border: 2px solid #0B0B0B' in css and 'text-align: left' in css
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
print(evaluate(setup+(root/'app.js').read_text()+(root/'admin.js').read_text()+'\n"JavaScript parsed and initialized"'))
tests='''
var result="pending";
(async()=>{
 await navigate("rules"); assert(!elements["login-view"].hidden,"guest gate");
 assert(elements.content.children.length===0,"guest content");
 user={username:"test",is_admin:false};saveToken("temporary-test-token");
 await navigate("admin");assert(!elements["menu-view"].hidden,"admin gate");
 user.is_admin=true;await navigate("admin");assert(elements.content.children.length===4,"admin sections");
 renderContent("rules",{rules:[{body:"<img>"}]});
 assert(elements.content.children[0].children[0].children[0].textContent==="<img>","text only");
 renderPermanentSchedule({reservation_phone_1:"7708615443",reservation_phone_2:"6788307590"});
 assert(elements.content.children.length===3,"permanent schedule days");
 assert(elements.content.children[0].children[0].textContent==="Monday","Monday heading");
 assert(elements.content.children[1].children[0].textContent==="Wednesday","Wednesday heading");
 assert(elements.content.children[2].children[0].textContent==="Thursday","Thursday heading");
 assert(elements.content.children[0].children[1].children[0].textContent==="Hold Em — 7:00 PM","Hold Em game and time");
 assert(elements.content.children[0].children[1].children[1].textContent==="Reserve Seat","Reserve Seat label");
 const sms=elements.content.children[0].children[1].children[1].href;
 assert(sms.startsWith("sms:+17708615443,+16788307590&body="),"both SMS recipients");
 assert(decodeURIComponent(sms.split("body=")[1])==="I would like to reserve a seat for Hold Em on Monday.","SMS body");
 let resolve;api=()=>new Promise(r=>resolve=r);
 const pending=navigate("rules");await navigate("menu");resolve({rules:[{body:"stale"}]});await pending;
 assert(elements.content.children.length===0,"stale response");
 api=async()=>{const e=Error("expired");e.status=401;throw e};
 await navigate("rules");assert(user===null&&!token&&!storage[SESSION_KEY],"expired session cleared");
 assert(elements.content.children.length===0,"expired content cleared");
 // Synthetic data only: no live credentials or protected club content.
 const profile={username:"test-member",display_name:"Test Member",is_admin:true};
 const bootstrap={user:profile,rules:[{id:1,body:"<test-body>",updated_at:"test"}],game_schedule:[],
   bonus_hands:[{id:"test",hand_name:"Bonus Hands Info",payout_text:null,description:"Test bonus text\\nSecond paragraph",sort_order:0,is_active:true,created_at:"test",updated_at:"test"}],
   settings:{reservation_phone_1:"",reservation_phone_2:""}};
 const calls=[];
 api=async(action,fields,session)=>{
   calls.push({action,fields,session});
   if(action==="login")return {session_token:"synthetic-session",...profile,expires_at:"test"};
   if(action==="bootstrap")return bootstrap;
   if(action==="member_settings")return {settings:{reservation_phone_1:"7708615443",reservation_phone_2:"6788307590"}};
   if(action==="logout")return {};
   throw Error("Unexpected API action: "+action);
 };
 $("username").value="test-member";$("pin").value=String(10 ** 3);
 await $("login-form").handlers.submit({preventDefault(){}});
 assert(token==="synthetic-session"&&storage[SESSION_KEY]===token,"top-level login session_token");
 assert(user.username===profile.username&&user.display_name===profile.display_name,"top-level profile");
 assert(!$("admin-button").hidden,"top-level admin flag");
 assert(!$("change-pin-button").hidden,"Change My PIN main-menu utility");
 assert(calls.length===1&&calls[0].action==="login"&&calls[0].session==="","login before protected fetch");
 assert($("pin").value==="","PIN cleared");
 assert(Object.keys(storage).length===1,"only session persisted");
 await navigate("rules");
 assert(calls[1].action==="bootstrap","bootstrap action");
 assert(elements.content.children[0].children[0].children[0].textContent==="<test-body>","rules array body");
 renderContent("rules",{rules:[{body:"first"},{body:"second"}]});
 assert(elements.content.children[0].children.length===1,"only first rules row");
 renderContent("rules",{rules:[]});assert(elements.content.children[0].children.length===1,"empty rules");
 await navigate("schedule");
 assert(calls[2].action==="member_settings","schedule uses settings only");
 assert(elements.content.children.length===3&&elements.content.children[1].children[0].textContent==="Wednesday","static schedule after navigation");
 await navigate("bonus");
 const bonus=elements.content.children[0].children[0];
 assert(bonus.children[0].textContent==="Test bonus text\\nSecond paragraph","bonus document text");
 renderContent("bonus",{bonus_hands:[{hand_name:"Bonus Hands Info",description:"later",is_active:true}]});
 assert(elements.content.children[0].children[0].children[0].textContent==="later","bonus document replacement");
 renderPermanentSchedule({reservation_phone_1:"",reservation_phone_2:""});
 assert(elements.content.children[0].children[1].children[1].textContent==="Reservation unavailable","empty settings disable SMS");
 user=null;await initialize();
 assert(calls[calls.length-1].action==="bootstrap"&&user.username===profile.username,"restore via bootstrap");
 await $("logout").handlers.click();
 assert(user===null&&!token&&!storage[SESSION_KEY]&&elements.content.children.length===0,"logout clears session and content");
 assert(calls[calls.length-1].action==="logout"&&calls[calls.length-1].session==="synthetic-session","logout revokes returned token");
 api=async()=>({token:"wrong-field",...profile});
 $("username").value="test-member";$("pin").value=String(10 ** 3);
 await $("login-form").handlers.submit({preventDefault(){}});
 assert(!token&&!user,"legacy token field rejected");
 // Admin screen and response regressions, using synthetic records only.
 user={username:"test-member",is_admin:true};saveToken("synthetic-session");
 const adminCalls=[];
 const responses={admin_users:{users:[{id:"self",username:"test-member",display_name:"Member",is_admin:true,is_active:true,created_at:"2026-01-01"},{id:"other",username:"other",display_name:"Other",is_admin:false,is_active:true,created_at:"2026-01-01"}],current_user_id:"self"},admin_rules:{rules:[{id:1,body:"Current rules"}]},admin_bonus:{bonus_text:"Saved bonus text"},admin_settings:{settings:{reservation_phone_1:"",reservation_phone_2:""}}};
 api=async(action,fields)=>{adminCalls.push({action,fields});return responses[action] || {ok:true}};
 await navigate("admin");
 assert(elements.content.children.length===4,"four Admin areas");
 assert(elements.content.children[0].textContent==="Users"&&elements.content.children[1].textContent==="Rules"&&elements.content.children[2].textContent==="Bonus Hands"&&elements.content.children[3].textContent==="Reservation Numbers","no schedule or PIN Admin areas");
 for(const section of ["users","rules","bonus","settings","pin"]){
   await openAdmin(section);
   assert(elements.content.children[0].textContent==="← Back to Admin","admin back button");
   assert(elements["content-title"].textContent===adminSections[section],"section title");
   assert(elements.content.children.length>=2,"section form");
 }
 await openAdmin("bonus");
 assert(elements.content.children[1].children[1].children[0].value==="Saved bonus text","bonus text editor");
 assert(elements.content.children[1].children.length===3,"one bonus text field and save");
 await openAdmin("users");
 const ownCard=elements.content.children[2];
 assert(ownCard.children.length===2,"no Change My PIN control inside Admin");
 await openAdmin("pin");
 const pinForm=elements.content.children[1];
 pinForm.children[1].children[0].value="1234";
 pinForm.children[2].children[0].value="5678";
 pinForm.children[3].children[0].value="5678";
 await pinForm.handlers.submit({preventDefault(){}});
 assert(adminCalls[adminCalls.length-1].action==="change_pin","PIN action");
 assert(pinForm.children[1].children[0].value===""&&pinForm.children[2].children[0].value==="","PIN inputs cleared");
 assert(elements.status.textContent==="Saved.","save feedback");
 assert(elements.content.children[0].textContent==="← Back to Admin","admin back button");
 api=async()=>{const error=Error("Forbidden");error.status=403;throw error};
 await openAdmin("users");assert(elements.status.textContent==="Forbidden","admin denial shown");
 assert(elements.content.children.length===2,"denied screen contains back and retry only");
 result="PASS: permanent schedule, settings-only member schedule, combined SMS recipients, simplified bonus text editor, Admin navigation, PIN placement, login, bootstrap, restore, rules, bonus hands, logout; guest/admin gates, duplicate-title removal, stale responses, session expiry";
})().catch(e=>result="FAIL: "+e.message);
'''
evaluate(tests)
result=evaluate('result');print(result);assert result.startswith('PASS')
print('PASS: unique HTML IDs')
