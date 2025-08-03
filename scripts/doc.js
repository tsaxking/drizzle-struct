const fs = require('fs');
const path = require('path');
const { getTemplateData, render } = require('jsdoc-to-markdown');

const main = async () => {
    const templateData = await getTemplateData({
        files: [
            path.resolve(process.cwd(), 'src/back-end.ts'),
            path.resolve(process.cwd(), 'src/front-end.ts'),
        ]
    });
    console.log(templateData);
};


main();