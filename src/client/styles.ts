export const css = `
.dsh-magpie{color:var(--dsw-alias-label-primary);font-family:inherit;font-size:14px;line-height:1.55;min-width:0}
.dsh-magpie *{box-sizing:border-box}
.dsh-magpie ::selection{background:var(--dsw-alias-interactive-bg-hover)}
.dsh-magpie h2{font-size:20px;font-weight:600;line-height:1.3;margin:0 0 12px}
.dsh-magpie h3{font-size:14px;font-weight:600;margin:24px 0 12px}
.dsh-magpie p{margin:0 0 14px;max-width:68ch}
.dsh-magpie .mp-muted{color:var(--dsw-alias-label-secondary);font-size:13px}
.dsh-magpie .mp-form{max-width:640px;padding:4px 0 24px}
.dsh-magpie .mp-field{display:flex;flex-direction:column;gap:6px;margin:18px 0}
.dsh-magpie label{font-size:13px;font-weight:500}
.dsh-magpie input:not([type=checkbox]){font:inherit;width:100%;min-width:0;padding:9px 11px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;caret-color:var(--dsw-alias-state-business-primary)}
.dsh-magpie input::placeholder{color:var(--dsw-alias-label-secondary)}
.dsh-magpie button,.dsh-magpie .mp-button{font:inherit;font-size:13px;line-height:1.4;display:inline-flex;align-items:center;justify-content:center;gap:6px;padding:7px 12px;min-height:32px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:transparent;color:var(--dsw-alias-label-primary);text-decoration:none;cursor:pointer}
.dsh-magpie button:hover:not(:disabled),.dsh-magpie .mp-button:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dsh-magpie button.mp-primary{background:var(--dsw-alias-state-business-primary);border-color:transparent;color:var(--dsw-alias-label-on-primary,white)}
.dsh-magpie button.mp-primary:hover:not(:disabled){filter:brightness(.94)}
.dsh-magpie button:disabled{opacity:.5;cursor:wait}
.dsh-magpie :is(button,a,input,summary):focus-visible{outline:2px solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:3px}
.dsh-magpie .mp-actions{display:flex;align-items:center;flex-wrap:wrap;gap:8px}
.dsh-magpie .mp-check{display:flex;align-items:flex-start;gap:9px;margin:18px 0;font-weight:400}
.dsh-magpie .mp-check input{margin-top:4px;accent-color:var(--dsw-alias-state-business-primary)}
.dsh-magpie details{margin:18px 0}
.dsh-magpie summary{cursor:pointer;color:var(--dsw-alias-label-secondary);font-size:13px;width:fit-content}
.dsh-magpie .mp-message{font-size:13px;padding:10px 12px;background:var(--dsw-alias-bg-layer-1);border-radius:8px;margin:14px 0;overflow-wrap:anywhere}
.dsh-magpie .mp-error{color:var(--dsw-alias-state-error-primary)}
.dsh-magpie .mp-status{display:flex;align-items:center;gap:7px;font-size:13px;color:var(--dsw-alias-label-secondary)}
.dsh-magpie .mp-dot{width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-label-tertiary);flex-shrink:0}
.dsh-magpie .mp-dot[data-online=true]{background:var(--dsw-alias-state-success-primary,var(--dsw-alias-state-business-primary))}
.dsh-magpie .mp-directory{margin:16px 0 22px;padding:0;list-style:none;border-top:1px solid var(--dsw-alias-border-l2);font-variant-numeric:tabular-nums}
.dsh-magpie .mp-directory li{display:flex;justify-content:space-between;gap:16px;padding:9px 0;border-bottom:1px solid var(--dsw-alias-border-l2)}
.dsh-magpie .mp-panel{height:100%;display:flex;flex-direction:column;min-height:0}
.dsh-magpie.mp-retained-management{position:fixed;z-index:0;overflow:hidden;min-width:0;min-height:0;contain:layout paint}
.dsh-magpie .mp-management-anchor{display:block;flex:1;width:100%;height:100%;min-height:0;pointer-events:none}
.dsh-magpie .mp-native-surface{position:relative;display:flex;flex:1;min-height:0}
.dsh-magpie .mp-native-failure{position:absolute;inset:0;z-index:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;padding:24px;background:var(--dsw-alias-bg-base);text-align:center}
.dsh-magpie .mp-header{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;padding:12px 20px;border-bottom:1px solid var(--dsw-alias-border-l2)}
.dsh-magpie .mp-heading{display:flex;gap:10px;align-items:center}
.dsh-magpie .mp-heading h2{margin:0;font-size:16px}
.dsh-magpie .mp-body{padding:24px;overflow:auto;scrollbar-width:thin;scrollbar-color:var(--dsw-alias-border-l2) transparent}
.dsh-magpie .mp-frame-area{flex:1;min-height:0;display:flex;flex-direction:column}
.dsh-magpie .mp-frame-note{font-size:12px;color:var(--dsw-alias-label-secondary);padding:8px 20px;border-bottom:1px solid var(--dsw-alias-border-l2)}
.dsh-magpie .mp-native-host{display:flex;flex:1;min-height:200px;min-width:0;background:var(--dsw-alias-bg-base)}
.dsh-magpie .mp-native-host webview{display:flex;width:100%;flex:1;min-height:200px;border:0}
.dsh-magpie .mp-danger{color:var(--dsw-alias-state-error-primary)}
.dsh-magpie-dock{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.dsh-magpie .mp-pill{border:0;border-radius:999px;min-height:24px;padding:3px 8px;font-size:12px;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-1)}
.dsh-magpie.mp-model-quota{display:inline-flex;min-width:0;max-width:100%}
.dsh-magpie button.mp-quota-pill{font-size:calc(var(--dsh-content-font-size-secondary,13px) - 1px);line-height:20px;font-variant-numeric:tabular-nums;border:0;border-radius:999px;background:transparent;min-height:24px;padding:1px 8px;color:var(--dsw-alias-label-secondary);max-width:100%;white-space:nowrap}
.dsh-magpie .mp-quota-pill span{overflow:hidden;text-overflow:ellipsis;min-width:0}
.dsh-magpie.mp-quota-dialog{position:fixed;z-index:1100;box-sizing:border-box;width:380px;max-width:calc(100vw - 24px);max-height:calc(100dvh - 24px);overflow:auto;overscroll-behavior:contain;border:0;border-radius:var(--dsw-radius-lg,16px);padding:16px;background:#fff;background:rgb(from var(--dsw-alias-bg-base,#fff) r g b / 1);background:rgb(from var(--dsw-specific-menu,var(--dsw-alias-bg-base,#fff)) r g b / 1);opacity:1;box-shadow:var(--dsw-elevation-prominent,0 8px 28px #0002);font-size:12px;line-height:18px;scrollbar-width:thin;scrollbar-color:var(--dsw-alias-border-l2) transparent;outline:0}
.dsh-magpie .mp-quota-title{display:flex;align-items:center;justify-content:space-between;gap:16px;padding-bottom:10px;margin-bottom:8px;border-bottom:.5px solid var(--dsw-alias-border-l2);font-weight:500}
.dsh-magpie .mp-quota-title>span{display:inline-flex;gap:6px;align-items:center}
.dsh-magpie .mp-quota-title button,.dsh-magpie .mp-quota-footer button{font-size:12px;border:0;padding:2px 6px;min-height:24px;color:var(--dsw-alias-label-secondary)}
.dsh-magpie .mp-quota-model{font-size:12px;overflow-wrap:anywhere;color:var(--dsw-alias-label-primary)}
.dsh-magpie p.mp-quota-scope{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);margin:6px 0 12px}
.dsh-magpie .mp-quota-account{border-top:.5px solid var(--dsw-alias-border-l2);margin-top:12px;padding-top:10px}
.dsh-magpie .mp-quota-account-name{display:flex;justify-content:space-between;gap:16px;margin-bottom:8px}
.dsh-magpie .mp-quota-account-name strong{font-weight:500}.dsh-magpie .mp-quota-account-name>span{color:var(--dsw-alias-label-secondary)}
.dsh-magpie .mp-quota-line{display:flex;justify-content:space-between;align-items:baseline;gap:16px;margin:4px 0;overflow-wrap:anywhere}
.dsh-magpie .mp-quota-line>span:last-child{text-align:right;font-variant-numeric:tabular-nums;flex-shrink:0;max-width:64%}
.dsh-magpie .mp-quota-window{margin:8px 0 10px}.dsh-magpie .mp-quota-bar{height:4px;border-radius:2px;overflow:hidden;background:var(--dsw-alias-border-l2);margin:5px 0}.dsh-magpie .mp-quota-bar>div{height:100%;border-radius:2px}
.dsh-magpie .mp-quota-time,.dsh-magpie .mp-quota-footer,.dsh-magpie p.mp-quota-notice{font-size:12px;color:var(--dsw-alias-label-secondary);margin:5px 0;overflow-wrap:anywhere}
.dsh-magpie .mp-quota-footer{border-top:.5px solid var(--dsw-alias-border-l2);padding-top:10px;margin-top:12px;display:flex;justify-content:space-between;align-items:center;gap:12px}
@media(max-width:600px){.dsh-magpie .mp-body{padding:18px 14px}.dsh-magpie .mp-header{padding:10px 14px}.dsh-magpie .mp-actions{gap:6px}.dsh-magpie .mp-frame-note{padding:8px 14px}}
`
