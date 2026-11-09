export const messages = {
 SESSION_INVALID: 'This form session is no longer valid. Copy any details you want to keep, then refresh the page and try again.',
 FORM_INVALID: 'We couldn’t verify this submission. Please reopen the official Xfinity Media form and try again.',
 FILE_COUNT: 'You can attach up to 10 files. Please remove some files and try again.',
 FILE_SIZE: 'Your attachments exceed the 25 MB total limit. Please reduce their size or remove some files.',
 FILE_NOTES: 'A file note is too long. Please shorten each note to 500 characters.',
 PROCESSING: 'Your submission is still processing. Please wait before trying again.',
 ATTEMPT_LIMIT: 'We couldn’t accept another attempt right now. Please contact Xfinity Media for help completing your submission.',
 SERVICE_LIMIT: 'We’re temporarily unable to accept submissions. Please try again later or contact Xfinity Media.',
 CUSTOMER_CONFLICT: 'We couldn’t match your details to an existing customer record. Please contact Xfinity Media so our team can help.',
 SAVE_FAILED: 'We couldn’t save your submission because of a system problem. Keep this page open and try again. If it happens again, please contact Xfinity Media.',
 UNCONFIRMED: 'We couldn’t confirm whether your submission was received. Keep this page open and try again so we can check its status.'
};
export function problem(code:string,message?:string) {
 return Object.assign(new Error(message || messages[code as keyof typeof messages] || messages.SAVE_FAILED),{publicCode:code});
}
export function publicError(error:any) {
 return {error:error?.publicCode ? error.message : messages.SAVE_FAILED,code:error?.publicCode || 'SAVE_FAILED'};
}
export function saveProblem(error:any) {
 if(error?.code==='23505' && String(error.message).includes('idx_customers_name_lower'))return problem('CUSTOMER_CONFLICT');
 if(error?.message==='Please try again later')return problem('SERVICE_LIMIT');
 if(['This intake link is unavailable or expired','Start a valid intake submission first','Invalid QR submission'].includes(error?.message))return problem('SESSION_INVALID');
 return problem('SAVE_FAILED');
}
