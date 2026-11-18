import {allowedApiPath} from '../../../../lib/paths.mjs';
import {commonHeaders,sessionToken,upstream,allowedOrigin} from '../../../../lib/server.mjs';
import {validateScenarioInput} from '../../../../lib/scenario.mjs';

export const dynamic='force-dynamic';
export async function GET(req,{params}){
  const segments=(await params).path;
  const u=new URL(req.url);
  const path=allowedApiPath(segments,u.search.slice(1));
  if(!path)return Response.json({detail:'Recurso no autorizado'},
    {status:404,headers:commonHeaders()});
  const token=await sessionToken();
  if(!token)return Response.json({detail:'Inicia sesión'},
    {status:401,headers:commonHeaders()});
  try{
    const r=await upstream(path,token);
    if(!r.ok){
      const status=[400,401,403,404,409,422].includes(r.status)?r.status:502;
      return Response.json({detail:status===401?'Sesión vencida':status===404?'Recurso no encontrado':'No se pudo consultar el recurso'},
        {status,headers:commonHeaders()});
    }
    const pdf=path.endsWith('/pdf');
    if(pdf){
      const disposition=r.headers.get('content-disposition')||'attachment; filename="cotizacion.pdf"';
      return new Response(r.body,{status:200,headers:{...commonHeaders('application/pdf'),
        'Content-Disposition':disposition}});
    }
    return new Response(r.body,{status:200,headers:commonHeaders()});
  }catch{return Response.json({detail:'FastAPI no responde; verifica que el puerto 8000 esté activo'},
    {status:503,headers:commonHeaders()});}
}

// Solo POST /simulations/evaluate: el backend RF-016 no modifica registros.
export async function POST(req,{params}){
  const segments=(await params).path;
  if(!Array.isArray(segments)||segments.join('/')!=='simulations/evaluate' ||
     new URL(req.url).search)return Response.json({detail:'Recurso no autorizado'},
       {status:404,headers:commonHeaders()});
  if(!allowedOrigin(req))return Response.json({detail:'Origen no autorizado'},
    {status:403,headers:commonHeaders()});
  if(!/^application\/json(?:;|$)/i.test(req.headers.get('content-type')||''))
    return Response.json({detail:'Content-Type debe ser JSON'}, {status:415,headers:commonHeaders()});
  const token=await sessionToken();
  if(!token)return Response.json({detail:'Inicia sesión'},
    {status:401,headers:commonHeaders()});
  const size=Number(req.headers.get('content-length')||0);
  if(size>2048)return Response.json({detail:'Solicitud demasiado grande'},
    {status:413,headers:commonHeaders()});
  let json;
  try{
    const raw=await req.text();
    if(raw.length>2048)throw Error('Too long');
    json=validateScenarioInput(JSON.parse(raw));
  }catch{return Response.json({detail:'JSON inválido'}, {status:400,headers:commonHeaders()});}
  if(!json)return Response.json({detail:'Campos hipotéticos inválidos'},
    {status:422,headers:commonHeaders()});
  try{
    const response=await upstream('simulations/evaluate',token,{method:'POST',body:json});
    const status=[200,400,401,403,404,409,422].includes(response.status)?response.status:502;
    const body=await response.json().catch(()=>({detail:'Respuesta inválida de FastAPI'}));
    return Response.json(status===200?body:{detail:status===401?'Sesión vencida':body.detail||'Error al simular'},
      {status,headers:commonHeaders()});
  }catch{return Response.json({detail:'FastAPI no responde'},
    {status:503,headers:commonHeaders()});}
}
