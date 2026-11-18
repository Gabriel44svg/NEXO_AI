import {allowedApiPath} from '../../../../lib/paths.mjs';
import {commonHeaders,sessionToken,upstream} from '../../../../lib/server.mjs';

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
