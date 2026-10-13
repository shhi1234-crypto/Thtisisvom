import {validate,handle} from "./index.ts";
Deno.test("VOM chat validates applicant details",()=>{
 const year=String(new Date().getFullYear()-25);
 if(validate("BIRTH_YEAR",year)!==year)throw Error("birth year");
 if(validate("PHONE","010-1234-5678")!=="01012345678")throw Error("phone");
 if(validate("EXPERIENCE","0")!=="0")throw Error("no experience");
 if(validate("REASON","노래를 즐기고 친구들과 공연을 해보고 싶습니다.")==="")throw Error("join reason");
});
Deno.test("invalid and unsafe fields are rejected",()=>{
 const cases:Array<[any,string]>=[
  ["BIRTH_YEAR","1899"],["BIRTH_YEAR","나이 25세"],["PHONE","010-11-222"],
  ["EXPERIENCE","-1"],["EXPERIENCE","1.5"],["REASON","짧음"],
  ["GENDER","이상한값"],["NAME","홍길동123"]
 ];
 for(const [step,v] of cases){
   let blocked=false;try{validate(step,v)}catch{blocked=true}
   if(!blocked)throw Error(step+" accepted invalid input");
 }
});
Deno.test("private chat collection stays closed without configured secret",async()=>{
 const request=new Request("https://localhost/",{method:"POST",headers:{"Content-Type":"application/json"},
   body:JSON.stringify({bot:{id:"test-bot"},userRequest:{utterance:"가입 신청",user:{id:"test-user-123"}}})});
 const response=await handle(request,null,"");
 if(response.status!==403)throw Error("chat was not fail-closed");
 const raw=await response.text();
 if(raw.includes("test-user-123"))throw Error("identity was echoed");
});
Deno.test("non-POST requests cannot collect applicant details",async()=>{
 const response=await handle(new Request("https://localhost/"),null,"x".repeat(32));
 if(response.status!==405)throw Error("GET did not fail");
});
