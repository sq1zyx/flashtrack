(function(){
  var toast = document.getElementById("toast");
  var toastTimer = null;

  function showToast(text){
    if(!toast) return;
    toast.textContent = text;
    toast.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function(){ toast.classList.remove("show"); }, 2600);
  }

  function copyText(text){
    try{
      if(navigator.clipboard && navigator.clipboard.writeText){
        return navigator.clipboard.writeText(text);
      }
    }catch(e){}
    try{
      var ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
      return Promise.resolve();
    }catch(e){
      return Promise.reject(e);
    }
  }

  document.querySelectorAll("[data-copy-email]").forEach(function(el){
    el.addEventListener("click", function(){
      var email = el.getAttribute("data-copy-email");
      copyText(email).then(function(){
        showToast("Email скопирован: " + email);
      }).catch(function(){
        showToast("Мой email: " + email);
      });
    });
  });
})();
