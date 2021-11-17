module.exports = {
  register: (Handlebars) => {
    Handlebars.registerHelper('notLocal', (network) => {
      return (network === "unknown") ? true : false;
    });
  }
}