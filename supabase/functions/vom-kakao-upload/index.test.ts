import {handle} from "./index.ts";
Deno.test("upload rejects outside-origin form submissions",async()=>{
  const req=new Request("https://example.test/",{method:"POST",headers:{"Content-Type":"application/json"},
    body:JSON.stringify({action:"status",ticket:"0".repeat(64)})});
  const res=await handle(req,null);
  if(res.status!==403)throw Error("cross-origin POST accepted");
});
Deno.test("upload rejects malformed links before database access",async()=>{
  const req=new Request("https://example.test/",{method:"POST",headers:{"Origin":"https://thisisvom.vercel.app","Content-Type":"application/json"},
    body:JSON.stringify({action:"status",ticket:"bad"})});
  const res=await handle(req,null);
  if(res.status!==403)throw Error("bad ticket accepted");
});
Deno.test("multipart upload requires ticket header",async()=>{
  const req=new Request("https://example.test/",{method:"POST",headers:{"Origin":"https://thisisvom.vercel.app"},
    body:new FormData()});
  const res=await handle(req,null);
  if(res.status!==403)throw Error("unauthenticated multipart upload accepted");
});
