import {validate,extractAnswers,handle} from "./index.ts";
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


Deno.test("multiple personal fields are extracted from one natural-language message",()=>{
  const a=extractAnswers("저는 김철수이고 98년생이에요. 전화번호는 010-1234-5678이에요. 소모임 닉네임은 철수이고 버스킹은 3번 해봤습니다. 노래하는 친구들을 만나고 싶어서 가입하려고요.");
  if(a.candidate_name!=="김철수"||a.birth_year!=="1998"||
    a.phone!=="01012345678"||a.somoim_nickname!=="철수"||
    a.busking_experience!=="3"||!a.join_reason?.includes("친구들"))throw Error(JSON.stringify(a));
});
Deno.test("slash-separated list can fill multiple known fields at once",()=>{
  const a=extractAnswers("김철수 / 1998년생 / 010-1234-5678 / 닉네임: 철수 / 버스킹 경험: 3회 / 직업: 대학생 / 지역: 인천 / 성별: 남성 / 가입 계기: 노래하는 사람들과 공연하고 싶어서 가입합니다.");
  for(const k of ["candidate_name","birth_year","phone","somoim_nickname","busking_experience","job","region","gender","join_reason"]){
    if(!a[k])throw Error(k+" missing from slash response");
  }
});
Deno.test("ambiguous numbers are not interpreted as dates or experience",()=>{
  const a=extractAnswers("저 28살이고 친구가 버스킹 100번 했다고 합니다. 제 번호는 아직 안 드릴게요.");
  if(a.birth_year||a.phone)throw Error("inferred private data");
});
Deno.test("invalid phone and year are ignored instead of silently saved",()=>{
  const a=extractAnswers("이름: 홍길동, 출생연도: 1899, 전화번호: 010-12-3333, 닉네임: 길동");
  if(a.phone||a.birth_year)throw Error("invalid entries should not be saved");
  if(a.candidate_name!=="홍길동"||a.somoim_nickname!=="길동")throw Error("valid entries lost");
});


Deno.test("labeled fields stop before the next labeled clause",()=>{
  const a=extractAnswers("닉네임: 철수이고 버스킹 경험: 3회");
  if(a.somoim_nickname!=="철수"||a.busking_experience!=="3")throw Error(JSON.stringify(a));
  const b=extractAnswers("직업: 대학생이고 지역: 인천");
  if(b.job!=="대학생"||b.region!=="인천")throw Error(JSON.stringify(b));
});